/**
 * Intake — a board made addressable from a website's feedback widget
 * (platform/backend.json services.intakeSubmit, middleware.intakeSecret):
 *
 *   slug = header('x-tm-intake'); secret = header('x-tm-secret')
 *   intakes/{slug} enabled, sha256(secret) == secretHash      → 401
 *   Origin ∈ allowedOrigins (when set and the browser sent one) → 403
 *   rateLimit('intake:' + slug, intake.limits)                 → 429
 *
 *   POST /v1/intake          → ticketCreate on intake.boardId, via 'intake'
 *   GET  /v1/intake/schema   → the board's public options (the widget's selects)
 *
 * THE ACTOR is INTAKE_ACTOR ('intake-bot', via 'intake'), narrowed to
 * tickets:write on this one board: ticketCreate accepts it without can()
 * because this door has already checked the slug + secret. The reporter is
 * stored on the ticket and also leads the description.
 */
import type { Context, Hono } from 'hono';
import {
  errors,
  INTAKE_ACTOR,
  INTAKE_HEADERS,
  INTAKE_MAX_ATTACHMENT_BYTES,
  IntakeSubmitReqSchema,
  paths,
  rateBuckets,
  storage,
  type Board,
  type BoardWithId,
  type FieldDef,
  type FieldValue,
  type Intake,
  type IntakeSchemaRes,
  type IntakeSubmitReq,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import type { AppEnv } from '../http/env.js';
import { makeCtx, type ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { invalidFromZod } from '../runtime/runner.js';
import { withBoardId } from '../tickets/access.js';
import { safeEqual, sha256hex } from './crypto.js';
import { idemKey, invoke } from './ops.js';
import { markdownIn, safeFileName } from './resolve.js';
import { toPublicBoard } from './public.js';
import { rateLimit } from './rateLimit.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // 5 MB of files, base64-inflated

interface IntakeHit {
  slug: string;
  intake: Intake;
  board: BoardWithId;
}

function corsHeaders(c: Context<AppEnv>, allowed: string[] | null): Record<string, string> {
  const origin = c.req.header('origin');
  if (!origin) return {};
  if (allowed && allowed.length && !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
  };
}

/** The intakeSecret middleware as a function: resolves the intake or throws. */
export async function authenticateIntake(c: Context<AppEnv>): Promise<IntakeHit> {
  const slug = c.req.header(INTAKE_HEADERS.slug)?.trim();
  const secret = c.req.header(INTAKE_HEADERS.secret)?.trim();
  if (!slug || !secret || slug.includes('/'))
    throw errors.unauthenticated(`Send ${INTAKE_HEADERS.slug} and ${INTAKE_HEADERS.secret}`);
  const snap = await db().doc(paths.intake(slug)).get();
  const intake = snap.exists ? (snap.data() as Intake) : undefined;
  if (!intake || !intake.enabled || !safeEqual(sha256hex(secret), intake.secretHash))
    throw errors.unauthenticated('Unknown intake or wrong secret');
  const origin = c.req.header('origin');
  if (origin && intake.allowedOrigins.length && !intake.allowedOrigins.includes(origin))
    throw errors.forbidden('This origin may not post to this intake');
  await rateLimit(rateBuckets.intake(slug), intake.limits, ports().clock.now());
  const b = await db().doc(paths.board(intake.boardId)).get();
  if (!b.exists) throw errors.unauthenticated('Unknown intake or wrong secret');
  const board = withBoardId(b.id, b.data() as Board);
  if (board.archivedAt !== null) throw errors.conflict('This board is archived');
  return { slug, intake, board };
}

export function intakeCtx(board: BoardWithId, requestId?: string): ServerCtx {
  return makeCtx({
    actor: INTAKE_ACTOR,
    via: 'intake',
    scopes: ['tickets:create'],
    boardIds: [board.id],
    ...(requestId ? { requestId } : {}),
  });
}

/** A widget value → the stored type of the field it is mapped to (or skipped). */
function coerce(def: FieldDef, v: unknown): FieldValue | undefined {
  if (v === null || v === undefined) return undefined;
  switch (def.type) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
      return String(v).slice(0, 5000);
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return typeof v === 'boolean' ? v : undefined;
    case 'select': {
      const o = def.options?.find(
        (x) => x.id === v || x.name.toLowerCase() === String(v).toLowerCase(),
      );
      return o?.id;
    }
    default:
      return undefined;
  }
}

function describe(req: IntakeSubmitReq, unmapped: Record<string, unknown>): string {
  const parts: string[] = [];
  if (req.reporter)
    parts.push(
      `Reported by ${req.reporter.name ? `${req.reporter.name} (${req.reporter.email})` : req.reporter.email}`,
    );
  if (req.description?.trim()) parts.push(req.description.trim());
  const meta = Object.entries(unmapped);
  if (meta.length)
    parts.push(
      meta
        .map(([k, v]) => `- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n'),
    );
  // markdownIn is given NO members below, so a reporter's '@address' stays text.
  return parts.join('\n\n');
}

export async function submitIntake(
  hit: IntakeHit,
  req: IntakeSubmitReq,
  idempotencyKey?: string,
  requestId?: string,
): Promise<{ id: string; key: string }> {
  const { intake, board } = hit;
  const ctx = intakeCtx(board, requestId);

  const fields: Record<string, FieldValue> = {};
  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.meta ?? {})) {
    const def = intake.fieldMap[k]
      ? board.fields.find((f) => f.id === intake.fieldMap[k] && !f.archived)
      : undefined;
    const val = def ? coerce(def, v) : undefined;
    if (def && val !== undefined) fields[def.id] = val;
    else unmapped[k] = v;
  }

  const ticketId = ctx.ids.id();
  const attachments: string[] = [];
  let total = 0;
  for (const a of req.attachments ?? []) {
    const bytes = Buffer.from(a.contentBase64, 'base64');
    total += bytes.length;
    if (total > INTAKE_MAX_ATTACHMENT_BYTES)
      throw errors.too_large('Attachments are limited to 5 MB in total');
    const name = safeFileName(a.name);
    const path = storage.attachment(board.id, ticketId, ctx.ids.id(), name);
    await ports().files.write(path, new Uint8Array(bytes), 'application/octet-stream');
    attachments.push(path);
  }

  const md = describe(req, unmapped);
  const d = intake.defaults;
  const res = await invoke(
    'ticketCreate',
    {
      boardId: board.id,
      ticketId,
      title: req.title,
      ...(md ? { description: await markdownIn(md, board, new Map()) } : {}),
      ...(d.stageId ? { stageId: d.stageId } : {}),
      ...(d.priorityId ? { priorityId: d.priorityId } : {}),
      ...(d.tagIds?.length ? { tagIds: d.tagIds } : {}),
      ...(d.assigneeUids?.length
        ? { assigneeUids: d.assigneeUids.filter((u) => board.access[u]) }
        : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(req.reporter
        ? {
            reporter: {
              email: req.reporter.email,
              ...(req.reporter.name ? { name: req.reporter.name } : {}),
            },
          }
        : {}),
    },
    ctx,
    idempotencyKey ?? null,
  );

  if (req.reporter?.email) {
    try {
      await ports().email.send({
        to: req.reporter.email,
        subject: `We've logged ${res.key}: ${req.title}`.slice(0, 200),
        text: `Thanks${req.reporter.name ? `, ${req.reporter.name}` : ''} — your report is ${res.key} on ${board.name}.\n\n${req.title}`,
        tag: 'intake-receipt',
      });
    } catch (e) {
      console.warn('[intake] receipt email failed', e);
    }
  }
  return { id: res.ticketId, key: res.key };
}

export function intakeSchema(board: BoardWithId): IntakeSchemaRes {
  const pub = toPublicBoard(board);
  return {
    board: { key: board.key, name: board.name },
    stages: pub.stages,
    priorities: pub.priorities,
    tags: pub.tags,
    fields: pub.fields,
  };
}

/** Routes on the /v1 router (registered before its bearer middleware). */
export function registerIntakeRoutes(v1: Hono<AppEnv>): void {
  const preflight = (c: Context<AppEnv>) =>
    c.body(null, 204, {
      ...corsHeaders(c, null),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': `content-type, ${INTAKE_HEADERS.slug}, ${INTAKE_HEADERS.secret}, idempotency-key`,
      'access-control-max-age': '600',
    });
  v1.options('/intake', preflight);
  v1.options('/intake/schema', preflight);

  v1.get('/intake/schema', async (c) => {
    const hit = await authenticateIntake(c);
    return c.json(intakeSchema(hit.board), 200, corsHeaders(c, hit.intake.allowedOrigins));
  });

  v1.post('/intake', async (c) => {
    const hit = await authenticateIntake(c);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw errors.too_large('Body too large');
    let json: unknown;
    try {
      json = JSON.parse(text || '{}');
    } catch {
      throw errors.invalid('Body is not valid JSON');
    }
    const parsed = IntakeSubmitReqSchema.safeParse(json);
    if (!parsed.success) throw invalidFromZod(parsed.error, 'The report is invalid');
    const res = await submitIntake(
      hit,
      parsed.data,
      idemKey(c.req.header('idempotency-key')),
      c.get('requestId'),
    );
    return c.json(res, 201, corsHeaders(c, hit.intake.allowedOrigins));
  });
}
