/**
 * icsFeed (platform/backend.json services.icsFeed) — GET /ics/{uid}.{token}.ics
 *
 * A calendar subscription URL that Google / Apple / Outlook poll: every
 * active, not-done ticket assigned to the person with a due date, as an
 * all-day or a timed VEVENT. READ-ONLY AND POLLED, on purpose — two-way sync
 * is a later-phase problem; seeing deadlines in your calendar is not.
 *
 * The token is DERIVED (HMAC of uid + a per-user version), never stored;
 * rotating bumps users/{uid}.icsVersion so every old URL stops working.
 * The app gets its URL from the `icsFeedUrl` command.
 */
import { COLLECTIONS, errors, paths, type Board, type Ticket, type User } from '@tm/shared';
import { zonedParts } from '@tm/shared/logic/index';
import { defineCommand } from '../commands/_registry.js';
import { door } from '../http/mounts.js';
import { safeEqual, serverMac } from '../platform/crypto.js';
import { appUrl } from '../platform/public.js';
import { db } from '../runtime/firebase.js';
import { ports } from '../adapters/index.js';

type IcsUser = User & { icsVersion?: number };

export const icsToken = (uid: string, version: number): string =>
  serverMac('ics', `${uid}:${version}`).slice(0, 32);

const icsPath = (uid: string, version: number) => `/ics/${uid}.${icsToken(uid, version)}.ics`;

// ─── the app's handle on it ──────────────────────────────────────────────────

defineCommand('icsFeedUrl', async (ctx, input) => {
  const ref = db().doc(paths.user(ctx.actor));
  let version = ((await ref.get()).data() as IcsUser | undefined)?.icsVersion ?? 0;
  if (input.rotate) {
    version += 1;
    await ref.set({ icsVersion: version }, { merge: true });
  }
  const path = icsPath(ctx.actor, version);
  const base = (process.env.API_URL ?? '').replace(/\/$/, '');
  return { url: `${base}${path}`, path };
});

// ─── iCalendar ───────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    // Never split a UTF-8 sequence.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

const utc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const pad = (n: number) => String(n).padStart(2, '0');

function dateIn(ms: number, tz: string, addDays = 0): string {
  const p = zonedParts(ms, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function buildCalendar(
  tickets: { id: string; t: Ticket; boardName: string }[],
  tz: string,
  now: number,
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskManager//Deadlines//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:TaskManager deadlines',
    `X-WR-TIMEZONE:${tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const { id, t, boardName } of tickets) {
    const url = `${appUrl()}/t/${t.key}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${id}@taskmanager.app`,
      `DTSTAMP:${utc(now)}`,
      `LAST-MODIFIED:${utc(t.updatedAt)}`,
      ...(t.dueAllDay
        ? [
            `DTSTART;VALUE=DATE:${dateIn(t.dueAt!, tz)}`,
            `DTEND;VALUE=DATE:${dateIn(t.dueAt!, tz, 1)}`,
          ]
        : [`DTSTART:${utc(t.dueAt!)}`, `DTEND:${utc(t.dueAt! + 30 * 60_000)}`]),
      `SUMMARY:${esc(`${t.key} · ${t.title}`)}`,
      `DESCRIPTION:${esc(`${boardName}\n${url}`)}`,
      `URL:${url}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ─── the feed ────────────────────────────────────────────────────────────────

door('ics').get('/:file', async (c) => {
  const m = /^(.+)\.([A-Za-z0-9_-]{32})\.ics$/.exec(c.req.param('file'));
  if (!m) throw errors.not_found('Unknown calendar');
  const [, uid, token] = m as unknown as [string, string, string];
  // The HMAC is the credential; a profile row only adds the version, zone and deletion.
  const user = ((await db().doc(paths.user(uid)).get()).data() ?? {}) as Partial<IcsUser>;
  if (user.deletedAt || !safeEqual(token, icsToken(uid, user.icsVersion ?? 0)))
    throw errors.not_found('Unknown calendar'); // a wrong token and no user look the same

  const snap = await db()
    .collectionGroup(COLLECTIONS.tickets)
    .where('assigneeUids', 'array-contains', uid)
    .where('state', '==', 'active')
    .get();
  const rows = snap.docs
    .map((d) => ({ id: d.id, boardId: d.ref.parent.parent!.id, t: d.data() as Ticket }))
    .filter(
      (r) =>
        r.t.dueAt !== null && r.t.stageCategory !== 'done' && r.t.stageCategory !== 'cancelled',
    );

  // Still on the board? (Removed people keep stale assignments until cleaned up.)
  const boardIds = [...new Set(rows.map((r) => r.boardId))];
  const boards = new Map<string, Board>();
  if (boardIds.length) {
    const bs = await db().getAll(...boardIds.map((b) => db().doc(paths.board(b))));
    for (const b of bs) if (b.exists) boards.set(b.id, b.data() as Board);
  }
  const visible = rows
    .filter((r) => {
      const b = boards.get(r.boardId);
      return b && b.access[uid] && b.archivedAt === null;
    })
    .sort((a, b) => a.t.dueAt! - b.t.dueAt!)
    .map((r) => ({ id: r.id, t: r.t, boardName: boards.get(r.boardId)!.name }));

  return c.body(buildCalendar(visible, user.timezone || 'UTC', ports().clock.now()), 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'cache-control': 'private, max-age=900',
    'content-disposition': 'inline; filename="taskmanager.ics"',
  });
});
