/**
 * THE COMMAND RUNNER — what every door calls (/api here; /v1 REST and MCP
 * from the platform step):
 *
 *   registry lookup → scope narrowing → zod parse Req → idempotency claim
 *     → handler(ctx, input) → zod parse Res → bump the board's revision
 *     → store for replay → answer
 *
 * Throws AppError only; the door turns it into problem+json (or an MCP tool
 * error). Anything that is not an AppError is a bug and becomes `internal`.
 *
 * THE REVISION (docs/plan/agents.html §W). This is the one choke point every
 * door funnels through, so it is where 'something on this board changed' is
 * announced: ONE tiny RTDB write to rev/{boardId} after the change is real.
 * Watchers — the app and the SDK's tm.watch() — listen to that node instead of
 * polling, and then ask for the DELTA. A replayed (idempotent) request bumps
 * nothing, because nothing changed. See platform/rtdbPaths.ts for which
 * commands count and why it is awaited.
 */
import { ZodError } from 'zod';
import { errors, isAppError, tokenMayCall, type AppError } from '@tm/shared';
import { getRegisteredCommand } from '../commands/_registry.js';
import { markCommandChange } from '../platform/rtdbPaths.js';
import type { ServerCtx } from './context.js';
import { claimIdempotency } from './idempotency.js';

export interface RunOptions {
  /**
   * Idempotency key override. The /api door uses input.clientId (default);
   * REST passes its Idempotency-Key header here. null disables it.
   */
  idempotencyKey?: string | null;
}

/** Zod issues → a 400 with the issues as a problem extension member. */
export function invalidFromZod(
  err: ZodError,
  message = 'The request did not match the command schema',
): AppError {
  return errors.invalid(message, {
    issues: err.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
  });
}

export async function runCommand(
  name: string,
  rawInput: unknown,
  ctx: ServerCtx,
  opts: RunOptions = {},
): Promise<unknown> {
  const cmd = getRegisteredCommand(name);
  if (!cmd) throw errors.not_found(`Unknown command "${name}"`);

  // Tokens (API keys, OAuth) only NARROW: a token reaches a command only when
  // the command lists one of its scopes (any-of); a command without scopes is
  // app-only. Finer checks (patchScopes, can()) happen in the handler.
  if (ctx.scopes) {
    if (!tokenMayCall(cmd.spec, ctx.scopes)) {
      const need = cmd.spec.scopes ?? [];
      throw errors.forbidden(
        need.length
          ? `This token needs one of: ${need.join(', ')}`
          : `"${name}" is not available to API tokens`,
      );
    }
  }

  const parsed = cmd.spec.req.safeParse(rawInput ?? {});
  if (!parsed.success) throw invalidFromZod(parsed.error);
  const input = parsed.data as { clientId?: string };

  const key = opts.idempotencyKey === undefined ? input.clientId : opts.idempotencyKey;
  const claim = key ? await claimIdempotency(ctx.actor, key, name, ctx.now) : null;
  if (claim?.kind === 'replay') return claim.res;

  try {
    const raw = await cmd.handler(ctx, input);
    const out = cmd.spec.res.safeParse(raw);
    if (!out.success) {
      // The handler broke its own contract: a bug, never the caller's fault.
      console.error(`[runner] ${name} returned an invalid response`, out.error.issues);
      throw errors.internal();
    }
    // The change is real and its answer is valid: tell the board's watchers.
    await markCommandChange(name, input, ctx);
    if (claim?.kind === 'claimed') await claim.complete(out.data);
    return out.data;
  } catch (e) {
    if (claim?.kind === 'claimed') await claim.release().catch(() => {});
    throw toAppError(e);
  }
}

/** Normalise anything thrown into an AppError (logging the unexpected ones). */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e as AppError;
  if (e instanceof ZodError) {
    // A handler parsing something itself (e.g. a nested document) — still the caller's input.
    return invalidFromZod(e);
  }
  console.error('[runner] unexpected error', e);
  return errors.internal();
}
