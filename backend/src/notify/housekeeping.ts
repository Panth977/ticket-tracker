/**
 * housekeeping — daily 03:00 UTC (app/backend.json services.housekeeping):
 * the jobs nobody should have to remember.
 *
 *   invites past expiresAt, still pending      → 'expired'
 *   inbox rows older than 90 days AND read     → deleted
 *   boards with autoArchiveDoneAfterDays       → done tickets completed longer ago archived
 *   unattached uploads older than 24h          → deleted (no ticket.files row points at them)
 *   webhook deliveries (and notify deliveries) older than 30 days → deleted
 *   agent inbox events acked more than 30 days ago → deleted (unacked stay)
 *   artifact builds beyond the newest ten (never the current), and upload
 *     zips nobody published within 24h         → deleted (artifacts/housekeeping.ts)
 *
 * Each part is independent; one failing is logged and the others still run.
 */
import {
  AGENT_EVENT_ACKED_TTL_MS,
  COLLECTIONS,
  ORPHAN_UPLOAD_TTL_MS,
  parseAttachmentPath,
  paths,
  type StoredActivity,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { artifactHousekeeping } from '../artifacts/housekeeping.js';
import { db, storageAdmin } from '../runtime/firebase.js';
import { typedCol } from '../runtime/index.js';
import { batchWriter } from '../tickets/doc.js';
import { readFiles } from '../tickets/read.js';

const DAY = 24 * 60 * 60 * 1000;
export const INBOX_READ_TTL_MS = 90 * DAY;
export const DELIVERY_TTL_MS = 30 * DAY;

export interface HousekeepingResult {
  invitesExpired: number;
  inboxDeleted: number;
  ticketsArchived: number;
  uploadsDeleted: number;
  deliveriesDeleted: number;
  agentEventsDeleted: number;
  artifactBuildsPruned: number;
  artifactUploadsDeleted: number;
  errors: string[];
}

export async function housekeeping(now: number): Promise<HousekeepingResult> {
  const r: HousekeepingResult = {
    invitesExpired: 0,
    inboxDeleted: 0,
    ticketsArchived: 0,
    uploadsDeleted: 0,
    deliveriesDeleted: 0,
    agentEventsDeleted: 0,
    artifactBuildsPruned: 0,
    artifactUploadsDeleted: 0,
    errors: [],
  };
  const part = async (
    name: keyof Omit<HousekeepingResult, 'errors'>,
    fn: () => Promise<number>,
  ) => {
    try {
      r[name] = await fn();
    } catch (e) {
      console.error(`[housekeeping] ${name} failed`, e);
      r.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await part('invitesExpired', () => expireInvites(now));
  await part('inboxDeleted', () => pruneInbox(now));
  await part('ticketsArchived', () => autoArchive(now));
  await part('uploadsDeleted', () => pruneUploads(now));
  await part('deliveriesDeleted', () => pruneDeliveries(now));
  await part('agentEventsDeleted', () => pruneAgentEvents(now));
  // Two counters from one pass over the artifacts (it also heals the RTDB mirror).
  await part('artifactBuildsPruned', async () => {
    const a = await artifactHousekeeping(now);
    r.artifactUploadsDeleted = a.uploadsDeleted;
    return a.buildsPruned;
  });
  return r;
}

export async function expireInvites(now: number): Promise<number> {
  const s = await typedCol('invites', paths.invites())
    .where('status', '==', 'pending')
    .where('expiresAt', '<', now)
    .get();
  const w = db().bulkWriter();
  for (const d of s.docs) void w.update(d.ref, { status: 'expired' });
  await w.close();
  return s.size;
}

export async function pruneInbox(now: number): Promise<number> {
  const s = await db()
    .collectionGroup('inbox')
    .where('createdAt', '<', now - INBOX_READ_TTL_MS)
    .get();
  const w = db().bulkWriter();
  let n = 0;
  for (const d of s.docs) {
    if (d.get('readAt') == null) continue; // unread rows stay, however old
    void w.delete(d.ref);
    n++;
  }
  await w.close();
  return n;
}

export async function autoArchive(now: number): Promise<number> {
  const boards = await typedCol('boards', paths.boards())
    .where('settings.autoArchiveDoneAfterDays', '>', 0)
    .get();
  let n = 0;
  for (const b of boards.docs) {
    const board = b.data();
    const days = board.settings.autoArchiveDoneAfterDays;
    if (!days || board.archivedAt) continue;
    const cutoff = now - days * DAY;
    const done = await typedCol('tickets', paths.tickets(b.id))
      .where('state', '==', 'active')
      .where('stageCategory', '==', 'done')
      .get();
    for (const t of done.docs) {
      const ticket = t.data();
      if (ticket.completedAt === null || ticket.completedAt > cutoff) continue;
      // §W: the change and its activity row are the same document — one write.
      const activity: StoredActivity = {
        id: db().collection('_').doc().id,
        action: 'state',
        changes: { state: { from: 'active', to: 'archived' } },
        actor: null,
        via: 'system',
        createdAt: now,
      };
      const batch = db().batch();
      const w = batchWriter(batch, { now, ids: ports().ids }, b.id, t.id, ticket);
      w.set({ state: 'archived', updatedAt: now });
      w.addActivity(activity, activity.id);
      w.touch(now);
      w.commit();
      await batch.commit();
      n++;
    }
  }
  return n;
}

/**
 * An upload is ATTACHED once a row in `ticket.files` points at its path
 * (ticketCreate / messagePost / the API upload write it). Anything else under
 * a ticket's prefix older than 24h was uploaded and abandoned. Thumbnails go
 * with their original.
 *
 * memory.html §J: ONLY the boards/ prefix is swept. A ticket file that lives
 * in a memory (an API upload, a memoryUpload — row.memory set) is a node of
 * that memory: its object is the memory's, never this sweep's, whether or
 * not the ticket row is ever posted in a message.
 */
export async function pruneUploads(now: number): Promise<number> {
  const bucket = storageAdmin().bucket();
  const [files] = await bucket.getFiles({ prefix: 'boards/' });
  let n = 0;
  const attached = new Map<string, Promise<Set<string>>>();
  const attachedPaths = (boardId: string, ticketId: string) => {
    const key = `${boardId}/${ticketId}`;
    let p = attached.get(key);
    if (!p) {
      p = readFiles(boardId, ticketId, { live: false }).then(
        (rows) => new Set(rows.map((f) => f.path)),
      );
      attached.set(key, p);
    }
    return p;
  };
  for (const f of files) {
    const created = Date.parse(String(f.metadata.timeCreated ?? f.metadata.updated ?? ''));
    if (!Number.isFinite(created) || now - created < ORPHAN_UPLOAD_TTL_MS) continue;
    const a = parseAttachmentPath(f.name);
    if (!a) continue; // thumbnails and anything that is not an attachment
    if ((await attachedPaths(a.boardId, a.ticketId)).has(f.name)) continue;
    const dir = f.name.slice(0, f.name.lastIndexOf('/') + 1);
    await bucket.deleteFiles({ prefix: dir, force: true });
    n++;
  }
  return n;
}

/** deliveries/ (notify) and boards/*\/webhooks/*\/deliveries (platform) share the collection id. */
export async function pruneDeliveries(now: number): Promise<number> {
  const s = await db()
    .collectionGroup('deliveries')
    .where('createdAt', '<', now - DELIVERY_TTL_MS)
    .get();
  const w = db().bulkWriter();
  for (const d of s.docs) void w.delete(d.ref);
  await w.close();
  return s.size;
}

/**
 * agentInbox/{agentId}/events: an event the agent acked more than 30 days ago
 * is done with; unacked ones stay however old (the orchestrator may be down).
 * collectionGroup('events') where ackedAt < cutoff — null never matches a range.
 */
export async function pruneAgentEvents(now: number): Promise<number> {
  const s = await db()
    .collectionGroup(COLLECTIONS.events)
    .where('ackedAt', '<', now - AGENT_EVENT_ACKED_TTL_MS)
    .get();
  const w = db().bulkWriter();
  let n = 0;
  for (const d of s.docs) {
    if (d.ref.parent.parent?.parent.id !== COLLECTIONS.agentInbox) continue;
    void w.delete(d.ref);
    n++;
  }
  await w.close();
  return n;
}
