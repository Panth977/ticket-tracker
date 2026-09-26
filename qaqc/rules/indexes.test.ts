/**
 * firestore.indexes.json — static checks (the emulator does not enforce
 * indexes, production does). Every index the spec lists is present, and
 * none is a single-field composite, which `firebase deploy` rejects.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Field = { fieldPath: string; order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: 'CONTAINS' };
type Index = {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: Field[];
};

const file = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../backend/firestore.indexes.json',
);
const json = JSON.parse(readFileSync(file, 'utf8')) as {
  indexes: Index[];
  fieldOverrides: { collectionGroup: string; fieldPath: string; indexes: object[] }[];
};

const sig = (i: Index) =>
  `${i.queryScope === 'COLLECTION_GROUP' ? 'group ' : ''}${i.collectionGroup}: ` +
  i.fields
    .map((f) => `${f.fieldPath} ${f.arrayConfig ?? (f.order === 'DESCENDING' ? 'DESC' : 'ASC')}`)
    .join(', ');

const have = new Set(json.indexes.map(sig));

describe('firestore.indexes.json', () => {
  it('phase 15 (§W) dropped the indexes the subcollections needed', () => {
    // messages/ and tasklists/ are fields of the ticket now: nothing queries them.
    for (const i of json.indexes)
      expect(['messages', 'tasklists']).not.toContain(i.collectionGroup);
    for (const o of json.fieldOverrides) expect(o.collectionGroup).not.toBe('messages');
  });

  it.each([
    // app/db.json tickets — INDEXES
    'tickets: state ASC, stageId ASC, rank ASC', // kanban columns
    'tickets: state ASC, dueAt ASC', // calendar
    'group tickets: assigneeUids CONTAINS, stageCategory ASC, dueAt ASC', // My Work
    'group tickets: state ASC, dueAt ASC', // deadlineSweep
    // the bell: where(archivedAt == null).orderBy(createdAt, desc)
    'inbox: archivedAt ASC, createdAt DESC',
    // invites: mine (by email) and a board's (admin)
    'invites: email ASC, status ASC, createdAt DESC',
    'invites: boardId ASC, status ASC, createdAt DESC',
    // views: shared, and my personal ones, in order
    'views: scope ASC, position ASC',
    'views: ownerUid ASC, position ASC',
    // Account › Notifications › Recent deliveries
    'deliveries: uid ASC, createdAt DESC',
    // REQUESTs from the build steps, resolved by integration
    'tickets: state ASC, stageId ASC, rank DESC', // lastRankInStage (append to a column)
    'tickets: state ASC, stageCategory ASC', // autoArchive
    'group tickets: assigneeUids CONTAINS, state ASC', // MCP my_work, ICS
    'tickets: state ASC, updatedAt DESC, __name__ DESC', // REST ticket list
    'boards: readerUids CONTAINS, key ASC', // REST board list
    'invites: status ASC, expiresAt ASC', // housekeeping
    // phase 2 (agents.html §B, §D)
    'agents: ownerUid ASC, createdAt DESC', // Agents page: mine, newest first
    'events: ackedAt ASC, createdAt ASC', // agent inbox feed: unacked, oldest first
  ])('has %s', (s) => {
    expect(have.has(s)).toBe(true);
  });

  it('has no single-field composite indexes and no duplicates', () => {
    for (const i of json.indexes) expect(i.fields.length, sig(i)).toBeGreaterThan(1);
    expect(have.size).toBe(json.indexes.length);
  });

  it('enables the collection-group lookups the backend runs', () => {
    const overrides = new Set(
      json.fieldOverrides.map((o) => `${o.collectionGroup}.${o.fieldPath}`),
    );
    expect(overrides.has('members.uid')).toBe(true); // profileUpdate fan-out
    expect(overrides.has('apiKeys.hash')).toBe(true); // API key auth
    expect(overrides.has('tickets.createdBy')).toBe(true); // accountExport, My work 'Created by me'
    expect(overrides.has('tickets.fileIds')).toBe(true); // §W: GET /v1/files/{fileId}
    expect(overrides.has('tickets.nextQuestionExpiresAt')).toBe(true); // §W: the question expiry sweep
    expect(overrides.has('events.ackedAt')).toBe(true); // housekeeping: acked agent events
  });

  it('expires idempotency records with a TTL policy', () => {
    expect(
      json.fieldOverrides.find((o) => o.collectionGroup === '_idem' && o.fieldPath === 'expiresAt'),
    ).toMatchObject({ ttl: true });
  });
});
