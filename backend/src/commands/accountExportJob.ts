/**
 * The `export` queue handler (queued by accountExport). Lives beside the
 * account commands; autoload imports commands/ and defineTask registers it.
 *
 *   exports/{uid}/{jobId}.zip
 *     profile.json            users/{uid} (+ which boards they are on)
 *     tickets.json            tickets they created or are assigned to
 *     messages.json           messages they authored
 *     files/{messageId}/…     files attached to those messages (up to 200 MB)
 *
 * Only boards they can STILL read are included: a board they left is no
 * longer theirs to take away. Then a signed URL (7 days) is e-mailed.
 * Re-running the task rewrites the same object — safe to retry.
 */
import { paths, storage, type Message, type Ticket, type User } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { auth, db } from '../runtime/firebase.js';
import { defineTask } from '../runtime/functions.js';
import { readAllMessages } from '../tickets/read.js';

export const EXPORT_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

// ─── a minimal ZIP writer (stored entries, no compression) ────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a .zip of `entries` (STORE method, UTF-8 names). Enough for JSON + originals. */
export function zip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, Buffer.from(e.data));

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

// ─── the job ─────────────────────────────────────────────────────────────────

const json = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v, null, 2), 'utf8'));
const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';

export async function runExport(jobId: string, uid: string): Promise<string> {
  const p = ports();
  const now = p.clock.now();
  const userSnap = await db().doc(paths.user(uid)).get();
  const user = userSnap.exists ? (userSnap.data() as User) : null;

  const boardsSnap = await db()
    .collection(paths.boards())
    .where('readerUids', 'array-contains', uid)
    .get();
  const boards = new Map(
    boardsSnap.docs.map((d) => [
      d.id,
      d.data() as { name: string; key: string; access: Record<string, string> },
    ]),
  );

  const tickets = new Map<string, Ticket & { id: string; boardId: string }>();
  const tq = db().collectionGroup('tickets');
  for (const snap of await Promise.all([
    tq.where('createdBy', '==', uid).get(),
    tq.where('assigneeUids', 'array-contains', uid).get(),
  ]))
    for (const d of snap.docs) {
      const boardId = d.ref.parent.parent!.id;
      if (boards.has(boardId)) tickets.set(d.id, { ...(d.data() as Ticket), id: d.id, boardId });
    }

  // §W: there is no messages collection group any more — a message is a row
  // inside its ticket. The export walks the tickets of the boards this person
  // can read (a handful, by design) and takes the rows they wrote, data pages
  // included, so nothing they said is missing from their own export.
  const messages: (Message & { id: string; ticketId: string; boardId: string })[] = [];
  for (const boardId of boards.keys()) {
    const ts = await db().collection(paths.tickets(boardId)).get();
    for (const t of ts.docs) {
      const rows = await readAllMessages(boardId, t.id, t.data() as Ticket);
      for (const m of rows)
        if (m.authorUid === uid) messages.push({ ...m, ticketId: t.id, boardId });
    }
  }

  const entries: { name: string; data: Uint8Array }[] = [
    {
      name: 'profile.json',
      data: json({
        uid,
        profile: user,
        boards: [...boards].map(([id, b]) => ({
          id,
          name: b.name,
          key: b.key,
          role: b.access[uid],
        })),
        exportedAt: now,
      }),
    },
    { name: 'tickets.json', data: json([...tickets.values()]) },
    { name: 'messages.json', data: json(messages) },
  ];

  let bytes = 0;
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      if (bytes + a.size > MAX_FILE_BYTES) break;
      try {
        const data = await p.files.read(a.path);
        bytes += data.length;
        entries.push({ name: `files/${m.id}/${safeName(a.id)}-${safeName(a.name)}`, data });
      } catch {
        // A file that is gone (message deleted meanwhile) is skipped, not fatal.
      }
    }
  }

  const path = storage.export(uid, jobId);
  await p.files.write(path, zip(entries), 'application/zip');
  const url = await p.files.signedDownloadUrl(path, now + EXPORT_URL_TTL_MS);

  let to = user?.email ?? '';
  if (!to)
    to =
      (
        await auth()
          .getUser(uid)
          .catch(() => null)
      )?.email ?? '';
  if (to)
    await p.email.send({
      to,
      subject: 'Your TaskManager export is ready',
      text: `Your data export is ready. Download it within 7 days:\n\n${url}\n`,
      tag: 'export',
    });
  return path;
}

defineTask('export', async ({ jobId, uid }) => {
  await runExport(jobId, uid);
});
