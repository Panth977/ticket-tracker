/**
 * TICKET ATTACHMENTS LIVE IN A BUCKET (docs/plan/bucket.html §J).
 *
 * A board takes no files of its own: a file put on a ticket is uploaded INTO a
 * bucket granted `write` to the board, at a path, and the ticket holds a
 * reference to it (bucket.html §E). Each board may set a DEFAULT — which of its
 * buckets, and a path TEMPLATE — so attaching is one confirm:
 *
 *     tickets/<ticketId>/<time>_<filename>
 *
 * Variables (and nothing else in angle brackets):
 *   <ticketId>  the ticket's key, e.g. ENG-42
 *   <time>      when it was attached, UTC, sortable: 20261005-211946
 *   <random6>   six random characters [a-z0-9]
 *   <filename>  the file's own name, extension included: logo.png
 *   <exe>       the extension alone, no dot: png ('' when there is none)
 *               (<ext> is accepted as the same thing)
 *
 * The app fills every variable when the attach dialog opens and puts the cursor
 * on the <filename> part. A path sent to messagePost / ticketCreate may still
 * hold <ticketId>: the server fills it with the ticket's key (that is how the
 * intake widget and inbound email file attachments before the key exists).
 */
import { z } from 'zod';
import { BucketIdSchema, normalizeBucketPath } from './schema.js';
import { StoragePathSchema } from '../types/index.js';

export const ATTACH_VARS = ['ticketId', 'time', 'random6', 'filename', 'exe'] as const;
export type AttachVar = (typeof ATTACH_VARS)[number];
const ALIASES: Record<string, AttachVar> = { ext: 'exe' };

/** Where a board's attachments go unless its settings say otherwise. */
export const DEFAULT_ATTACH_TEMPLATE = 'tickets/<ticketId>/<time>_<filename>';
export const ATTACH_TEMPLATE_MAX = 512;

const VAR_RE = /<([A-Za-z0-9_]*)>/g;

/** Why `t` cannot be a path template, or null. */
export function attachTemplateProblem(t: string): string | null {
  if (!t.trim()) return 'Give a path';
  if (t.length > ATTACH_TEMPLATE_MAX) return `At most ${ATTACH_TEMPLATE_MAX} characters`;
  for (const m of t.matchAll(VAR_RE)) {
    const v = m[1]!;
    if (!(ATTACH_VARS as readonly string[]).includes(v) && !ALIASES[v])
      return `<${v}> is not a variable — use ${ATTACH_VARS.map((x) => `<${x}>`).join(' ')}`;
  }
  if (/[<>]/.test(t.replace(VAR_RE, ''))) return "A '<' or '>' that is not a variable";
  const sample = fillAttachTemplate(t, {
    ticketKey: 'ABC-1',
    at: 0,
    random6: 'abc123',
    filename: 'file.txt',
  });
  if (!sample) return "That path can't be used";
  return null;
}

export const AttachTemplateSchema = z
  .string()
  .max(ATTACH_TEMPLATE_MAX)
  .superRefine((t, ctx) => {
    const p = attachTemplateProblem(t);
    if (p) ctx.addIssue({ code: 'custom', message: p });
  });

/** boards/{b}.attachBucket: where this board's ticket attachments go by default. */
export const BoardAttachBucketSchema = z
  .object({ bucketId: BucketIdSchema, template: AttachTemplateSchema })
  .strict();
export type BoardAttachBucket = z.infer<typeof BoardAttachBucketSchema>;

/** <time>: UTC, sortable, safe in a path. */
export function attachTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** <random6>. */
export function random6(rand: () => number = Math.random): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(rand() * abc.length)];
  return s;
}

/** 'logo.png' → 'png'; 'Makefile' → ''; '.env' → ''. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** A file's own name made fit for one path segment ('/' and control characters go). */
export function attachFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\u0000-\u001f/\\]/g, '_').trim();
  return s === '' || s === '.' || s === '..' ? 'file' : s.slice(0, 200);
}

export interface AttachValues {
  /** null leaves <ticketId> in place, for the server to fill. */
  ticketKey: string | null;
  /** Millis for <time>. */
  at: number;
  random6: string;
  filename: string;
}

export interface FilledPath {
  path: string;
  /**
   * Where the (last) <filename> landed in `path`: [start, end). The app selects
   * it so typing replaces the name. null when the template has none.
   */
  name: [number, number] | null;
}

const MARK = '';

/**
 * Fill a template. Returns null when the result is not a usable bucket path.
 * With ticketKey null, '<ticketId>' stays in the result (the server fills it).
 */
export function fillAttachTemplate(t: string, v: AttachValues): FilledPath | null {
  const file = attachFileName(v.filename);
  const keep = '';
  const raw = t.replace(VAR_RE, (_, name: string) => {
    const k = ALIASES[name] ?? (name as AttachVar);
    switch (k) {
      case 'ticketId':
        return v.ticketKey ?? keep;
      case 'time':
        return attachTime(v.at);
      case 'random6':
        return v.random6;
      case 'exe':
        return extensionOf(file);
      case 'filename':
        return MARK + file + MARK;
      default:
        return '';
    }
  });
  const norm = normalizeBucketPath(raw);
  if (!norm) return null;
  let name: [number, number] | null = null;
  const end = norm.lastIndexOf(MARK);
  const start = end > 0 ? norm.lastIndexOf(MARK, end - 1) : -1;
  if (start >= 0) {
    // Positions in the string with every mark removed.
    const before = norm.slice(0, start).split(MARK).join('');
    name = [before.length, before.length + (end - start - 1)];
  }
  let path = norm.split(MARK).join('');
  if (v.ticketKey === null) path = path.split(keep).join('<ticketId>');
  return { path, name };
}

/** Put the server's ticket key into a path the client could not finish. */
export const fillTicketKey = (path: string, key: string): string =>
  path.split('<ticketId>').join(key);

/**
 * messagePost / ticketCreate `bucketUploads[]`: bytes ALREADY in Storage under
 * the bucket (buckets/{bucketId}/{fileId}/{name} — the app uploads with
 * metadata { boardId }, which storage.rules checks), to become a NEW file at
 * `path` (a '<ticketId>' in it is filled by the server). Never replaces a
 * file: a taken path gets ' (2)', ' (3)'… before the extension.
 */
export const BucketUploadSchema = z
  .object({
    bucketId: BucketIdSchema,
    path: z.string().min(1).max(1024),
    storagePath: StoragePathSchema,
  })
  .strict();
export type BucketUpload = z.infer<typeof BucketUploadSchema>;

/** 'a/b.png' taken → 'a/b (2).png', 'a/b (3).png', … */
export function numberedPath(path: string, n: number): string {
  const slash = path.lastIndexOf('/') + 1;
  const base = path.slice(slash);
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  return `${path.slice(0, slash)}${stem} (${n})${ext}`;
}
