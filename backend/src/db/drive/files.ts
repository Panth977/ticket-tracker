/**
 * TICKETS AS FILES IN GOOGLE DRIVE (docs/plan/bucket.html §L).
 *
 * A board whose `storage` is Drive keeps every ticket in its folder there:
 *
 *   <board folder>/tickets/<ticketId>/meta.json        the ticket document, minus its messages
 *   <board folder>/tickets/<ticketId>/messages/<ISO time>_<messageId>.json
 *                                                       one file per inline message
 *   <board folder>/tickets/<ticketId>/pages/<NNN>.json  older messages and activity, packed (§W)
 *
 * Drive is the only copy. Firestore keeps, per ticket, boards/{b}/driveRev/{t}:
 * where the files are (ids), a version that moves on every write (what open
 * screens listen to) and the short write lease (lease.ts).
 *
 * Everything here speaks ENCODED JSON (values.ts): the router decodes.
 *
 * READ COST. A file's head revision says whether its contents changed, so a
 * listing (one request for the ticket's folder and its messages folder) tells
 * which files to download; unchanged ones come from the process's cache. A
 * Drive ticket keeps fewer messages inline than a Firestore one
 * (DRIVE_INLINE_MESSAGES) so a cold read stays a handful of downloads.
 */
import type { DriveApi, DriveItem } from '../../bucket/drive/api.js';
import { isFolder } from '../../bucket/drive/api.js';

type Json = Record<string, unknown>;

export const META = 'meta.json';
export const MESSAGES = 'messages';
export const PAGES = 'pages';
export const TICKETS = 'tickets';
/** §L4: archived tickets live here, out of the way of every list of active ones. */
export const ARCHIVE = 'archive';
/** appProperty on meta.json: the ticket's state, so a list of active ones skips the rest unread. */
export const PROP_STATE = 'tmState';
export const JSON_MIME = 'application/json';
/** appProperties on every meta.json: what a board's listing searches by. */
export const PROP_BOARD = 'tmBoard';
export const PROP_TICKET = 'tmTicket';

/** Where a board's tickets live. */
export interface DriveBoard {
  boardId: string;
  /** Whose Drive (their connection makes every call). */
  uid: string;
  folderId: string;
  ticketsFolderId: string | null;
}

/** Where one ticket's files are (cached here, and on its driveRev doc). */
export interface TicketPointers {
  folderId: string;
  messagesId: string | null;
  pagesId: string | null;
  metaId: string | null;
}

/** A ticket as read: the encoded document and which file each part is. */
export interface TicketFiles {
  ptr: TicketPointers;
  /** Encoded document (meta.json + its message files), undefined when there is none. */
  doc: Json | undefined;
  /** messageId → its file. */
  messageFiles: Map<string, { id: string; name: string }>;
}

// ─── cache ───────────────────────────────────────────────────────────────────

/** fileId → its parsed contents at a head revision. */
const contents = new Map<string, { rev: string; json: Json }>();
const MAX_CACHED = 20_000;
/** `${boardId}/${ticketId}` → pointers. */
const pointers = new Map<string, TicketPointers>();

export function rememberPointers(boardId: string, ticketId: string, p: TicketPointers): void {
  pointers.set(`${boardId}/${ticketId}`, p);
}
export const knownPointers = (boardId: string, ticketId: string): TicketPointers | undefined =>
  pointers.get(`${boardId}/${ticketId}`);
export function forgetTicket(boardId: string, ticketId: string): void {
  pointers.delete(`${boardId}/${ticketId}`);
}
/** Tests. */
export function clearDriveTicketCache(): void {
  contents.clear();
  pointers.clear();
}

async function readJson(drive: DriveApi, f: DriveItem): Promise<Json> {
  return readJsonFile(drive, f);
}

/** A JSON file's contents (cached by head revision). */
export async function readJsonFile(drive: DriveApi, f: DriveItem): Promise<Json> {
  const hit = contents.get(f.id);
  if (hit && f.headRevisionId && hit.rev === f.headRevisionId) return hit.json;
  const stream = await drive.download(f.id);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  let json: Json;
  try {
    const parsed = JSON.parse(text) as unknown;
    json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    // A file someone broke by hand in Drive reads as empty rather than taking the board down.
    console.warn(`[drive] ${f.name} (${f.id}) is not JSON; ignored`);
    json = {};
  }
  if (f.headRevisionId) {
    if (contents.size > MAX_CACHED) contents.clear();
    contents.set(f.id, { rev: f.headRevisionId, json });
  }
  return json;
}

export const rememberJson = (f: DriveItem, json: Json): void => remember(f, json);

function remember(f: DriveItem, json: Json): void {
  if (f.headRevisionId) contents.set(f.id, { rev: f.headRevisionId, json });
}

/** Run `fn` over `items`, at most `n` at a time. */
export async function pool<T, R>(
  items: readonly T[],
  n: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const toBytes = (json: unknown) => new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);

/** `2026-10-18T19:20:57.113Z_<id>.json` — a name sort is the thread's order. */
export function messageFileName(m: Json): string {
  const at = typeof m.createdAt === 'number' ? m.createdAt : 0;
  return `${new Date(at).toISOString()}_${String(m.id)}.json`;
}
const messageIdOf = (name: string): string | null => {
  const m = /^[^_]+_(.+)\.json$/.exec(name);
  return m ? m[1]! : null;
};
export const pageFileName = (page: string) => `${page}.json`;

// ─── folders ─────────────────────────────────────────────────────────────────

/** The board's tickets/ folder (made on first use when the board has none yet). */
export async function ticketsFolder(drive: DriveApi, b: DriveBoard): Promise<string> {
  if (b.ticketsFolderId) return b.ticketsFolderId;
  const kids = await drive.children([b.folderId]);
  const hit = kids.find((k) => isFolder(k) && k.name === TICKETS);
  const id = hit ? hit.id : (await drive.createFolder(b.folderId, TICKETS)).id;
  b.ticketsFolderId = id;
  return id;
}

/** A ticket's folder: from what we know, else found by name, else (create) made. */
const archives = new Map<string, string>();
/** The board's archive/ folder (made on first use). */
export function archiveFolder(drive: DriveApi, b: DriveBoard): Promise<string> {
  const hit = archives.get(b.folderId);
  if (hit) return Promise.resolve(hit);
  // Tickets archived in parallel share one lookup (one archive/ folder, not one each).
  let p = archiving.get(b.folderId);
  if (!p) {
    p = (async () => {
      const kids = await drive.children([b.folderId]);
      const found = kids.find((k) => isFolder(k) && k.name === ARCHIVE);
      const id = found ? found.id : (await drive.createFolder(b.folderId, ARCHIVE)).id;
      archives.set(b.folderId, id);
      return id;
    })().finally(() => archiving.delete(b.folderId));
    archiving.set(b.folderId, p);
  }
  return p;
}
const archiving = new Map<string, Promise<string>>();

export async function ticketFolder(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  known: TicketPointers | undefined,
  create: boolean,
): Promise<TicketPointers | null> {
  const hit = known ?? knownPointers(b.boardId, ticketId);
  if (hit) return hit;
  const parent = await ticketsFolder(drive, b);
  let folder = (await drive.children([parent])).find((k) => isFolder(k) && k.name === ticketId);
  if (!folder) {
    const arch =
      archives.get(b.folderId) ??
      (await drive.children([b.folderId])).find((k) => isFolder(k) && k.name === ARCHIVE)?.id;
    if (arch)
      folder = (await drive.children([arch])).find((k) => isFolder(k) && k.name === ticketId);
  }
  if (!folder && !create) return null;
  const folderId = folder
    ? folder.id
    : (
        await drive.createFolder(parent, ticketId, {
          [PROP_BOARD]: b.boardId,
          [PROP_TICKET]: ticketId,
        })
      ).id;
  const ptr: TicketPointers = { folderId, messagesId: null, pagesId: null, metaId: null };
  if (folder) {
    const inside = await drive.children([folderId]);
    ptr.messagesId = inside.find((k) => isFolder(k) && k.name === MESSAGES)?.id ?? null;
    ptr.pagesId = inside.find((k) => isFolder(k) && k.name === PAGES)?.id ?? null;
    ptr.metaId = inside.find((k) => !isFolder(k) && k.name === META)?.id ?? null;
  }
  rememberPointers(b.boardId, ticketId, ptr);
  return ptr;
}

// ─── the ticket document ─────────────────────────────────────────────────────

/** Read a ticket: one listing, then only the files whose revision changed. */
export async function readTicket(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  known?: TicketPointers,
): Promise<TicketFiles | null> {
  const ptr = await ticketFolder(drive, b, ticketId, known, false);
  if (!ptr) return null;
  const listed = ptr.messagesId;
  let listing: DriveItem[];
  try {
    listing = await drive.children(listed ? [ptr.folderId, listed] : [ptr.folderId]);
  } catch (e) {
    // A stale pointer (folder trashed or moved in Drive): forget it and look again once.
    if (known || knownPointers(b.boardId, ticketId)) {
      forgetTicket(b.boardId, ticketId);
      return readTicket(drive, b, ticketId);
    }
    throw e;
  }
  const top = listing.filter((f) => f.parents.includes(ptr.folderId));
  const meta = top.find((f) => !isFolder(f) && f.name === META);
  ptr.messagesId = top.find((f) => isFolder(f) && f.name === MESSAGES)?.id ?? null;
  ptr.pagesId = top.find((f) => isFolder(f) && f.name === PAGES)?.id ?? null;
  let msgFiles: DriveItem[] = [];
  if (ptr.messagesId)
    msgFiles =
      ptr.messagesId === listed
        ? listing.filter((f) => f.parents.includes(listed))
        : await drive.children([ptr.messagesId]);
  ptr.metaId = meta?.id ?? null;
  rememberPointers(b.boardId, ticketId, ptr);
  if (!meta) return { ptr, doc: undefined, messageFiles: new Map() };
  const files = msgFiles
    .filter((f) => !isFolder(f) && f.name.endsWith('.json'))
    .sort((a, z) => (a.name < z.name ? -1 : 1));
  const [doc, ...msgs] = await pool([meta, ...files], 12, (f) => readJson(drive, f));
  const messageFiles = new Map<string, { id: string; name: string }>();
  const recent: Json[] = [];
  files.forEach((f, i) => {
    const m = msgs[i]!;
    const id = typeof m.id === 'string' ? m.id : messageIdOf(f.name);
    if (!id) return;
    messageFiles.set(id, { id: f.id, name: f.name });
    recent.push({ ...m, id });
  });
  return { ptr, doc: { ...doc!, recentMessages: recent }, messageFiles };
}

/**
 * Write a ticket document: meta.json, plus the message files that changed —
 * new ones created, edited ones replaced, ones that left the inline thread
 * (spilled to a page, or deleted) trashed. `before` is what was read.
 */
export async function writeTicket(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  before: TicketFiles | null,
  doc: Json,
): Promise<TicketPointers> {
  const ptr = (await ticketFolder(drive, b, ticketId, before?.ptr, true))!;
  const { recentMessages, ...meta } = doc;
  const msgs = (Array.isArray(recentMessages) ? recentMessages : []) as Json[];
  const oldDoc = before?.doc;
  const oldMsgs = new Map(
    ((oldDoc?.recentMessages as Json[] | undefined) ?? []).map((m) => [String(m.id), m]),
  );
  const files = new Map(before?.messageFiles ?? []);
  if (msgs.length && !ptr.messagesId)
    ptr.messagesId = (await drive.createFolder(ptr.folderId, MESSAGES)).id;

  const jobs: (() => Promise<unknown>)[] = [];
  const props = {
    [PROP_BOARD]: b.boardId,
    [PROP_TICKET]: ticketId,
    [PROP_STATE]: String(meta.state ?? ''),
  };
  // §L4: archived ↔ active moves the ticket's folder between archive/ and tickets/.
  const wasArchived = before?.doc ? before.doc.state === 'archived' : false;
  const isArchived = meta.state === 'archived';
  if (wasArchived !== isArchived || (!before?.doc && isArchived)) {
    const to = isArchived ? await archiveFolder(drive, b) : await ticketsFolder(drive, b);
    const from = isArchived ? await ticketsFolder(drive, b) : await archiveFolder(drive, b);
    await drive.update(ptr.folderId, { addParent: to, removeParent: from }).catch((e) => {
      console.warn(`[drive] ${b.boardId}/${ticketId}: folder not moved`, e);
    });
  }
  jobs.push(async () => {
    const f = await drive.putSmall({
      fileId: ptr.metaId ?? undefined,
      create: ptr.metaId ? undefined : { parentId: ptr.folderId, name: META },
      mime: JSON_MIME,
      bytes: toBytes(meta),
      props,
    });
    ptr.metaId = f.id;
    remember(f, meta);
  });
  const keep = new Set<string>();
  for (const m of msgs) {
    const id = String(m.id);
    keep.add(id);
    const old = oldMsgs.get(id);
    const file = files.get(id);
    if (file && old && JSON.stringify(old) === JSON.stringify(m)) continue;
    const { id: _id, ...body } = m;
    const content = { id, ...body };
    jobs.push(async () => {
      const f = await drive.putSmall({
        fileId: file?.id,
        create: file ? undefined : { parentId: ptr.messagesId!, name: messageFileName(m) },
        mime: JSON_MIME,
        bytes: toBytes(content),
      });
      files.set(id, { id: f.id, name: f.name });
      remember(f, content);
    });
  }
  for (const [id, f] of files)
    if (!keep.has(id))
      jobs.push(async () => {
        await drive.trash(f.id).catch(() => undefined);
        files.delete(id);
      });
  await pool(jobs, 8, (j) => j());
  rememberPointers(b.boardId, ticketId, ptr);
  return ptr;
}

/** Delete a ticket: its folder goes to Drive's trash (restorable there for 30 days). */
export async function trashTicket(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  known?: TicketPointers,
): Promise<void> {
  const ptr = await ticketFolder(drive, b, ticketId, known, false);
  if (ptr) await drive.trash(ptr.folderId).catch(() => undefined);
  forgetTicket(b.boardId, ticketId);
}

// ─── pages (boards/{b}/tickets/{t}/data/{NNN}) ───────────────────────────────

export async function listPages(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
): Promise<{ id: string; file: DriveItem }[]> {
  const ptr = await ticketFolder(drive, b, ticketId, undefined, false);
  if (!ptr?.pagesId) return [];
  const kids = await drive.children([ptr.pagesId]);
  return kids
    .filter((f) => !isFolder(f) && f.name.endsWith('.json'))
    .map((f) => ({ id: f.name.slice(0, -'.json'.length), file: f }));
}

export async function readPage(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  page: string,
): Promise<Json | undefined> {
  const hit = (await listPages(drive, b, ticketId)).find((p) => p.id === page);
  return hit ? readJson(drive, hit.file) : undefined;
}

export async function writePage(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
  page: string,
  doc: Json | undefined,
): Promise<void> {
  const ptr = (await ticketFolder(drive, b, ticketId, undefined, true))!;
  const existing = (await listPages(drive, b, ticketId)).find((p) => p.id === page);
  if (!doc) {
    if (existing) await drive.trash(existing.file.id);
    return;
  }
  if (!ptr.pagesId) {
    ptr.pagesId = (await drive.createFolder(ptr.folderId, PAGES)).id;
    rememberPointers(b.boardId, ticketId, ptr);
  }
  const f = await drive.putSmall({
    fileId: existing?.file.id,
    create: existing ? undefined : { parentId: ptr.pagesId, name: pageFileName(page) },
    mime: JSON_MIME,
    bytes: toBytes(doc),
  });
  remember(f, doc);
}

export async function readPages(
  drive: DriveApi,
  b: DriveBoard,
  ticketId: string,
): Promise<{ id: string; doc: Json }[]> {
  const pages = await listPages(drive, b, ticketId);
  return pool(pages, 8, async (p) => ({ id: p.id, doc: await readJson(drive, p.file) }));
}

// ─── the board ───────────────────────────────────────────────────────────────

/**
 * Every ticket of a board, as its meta.json (no messages: a list never needs
 * the thread, and reading every message file of every ticket would be slow).
 * One search for the board's meta files, then only the changed ones are downloaded.
 */
export async function listTickets(
  drive: DriveApi,
  b: DriveBoard,
  opts: { activeOnly?: boolean } = {},
): Promise<{ id: string; doc: Json; file: DriveItem }[]> {
  const metas = (await drive.findByProp(PROP_BOARD, b.boardId)).filter(
    (f) =>
      !isFolder(f) &&
      f.name === META &&
      f.appProperties[PROP_TICKET] &&
      // A list of active tickets never downloads an archived one (§L4).
      !(opts.activeOnly && f.appProperties[PROP_STATE] && f.appProperties[PROP_STATE] !== 'active'),
  );
  const docs = await pool(metas, 16, (f) => readJson(drive, f));
  return metas.map((f, i) => ({
    id: f.appProperties[PROP_TICKET]!,
    doc: { ...docs[i]!, recentMessages: [] },
    file: f,
  }));
}

/** One meta.json by its file id (a ticket the search index has not caught up with yet). */
export async function readMeta(drive: DriveApi, metaId: string): Promise<Json | null> {
  const f = await drive.get(metaId);
  if (!f || f.trashed) return null;
  return { ...(await readJson(drive, f)), recentMessages: [] };
}
