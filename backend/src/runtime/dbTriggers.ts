/**
 * DOCUMENT TRIGGERS, store-neutral.
 *
 * On Firebase, Cloud Functions deliver onDocumentWritten events (index.ts
 * registers DOC_TRIGGERS with firebase-functions). A store without that
 * service (SQLite) announces each committed change instead, and
 * installDbTriggers() turns those announcements into the SAME events for the
 * SAME handlers — so onTicketWritten / onMessageWritten neither know nor care
 * which store fired them.
 *
 * Delivery matches Firestore's contract: after the commit, asynchronously,
 * at least once, with a unique event id (handlers dedupe on it).
 */
import { dbKind } from '../db/index.js';
import { sqliteDb, type DocChange } from '../db/sqlite/index.js';
import { getTrigger, type TriggerHandlers } from './functions.js';

type DocTriggerName = 'onTicketWritten' | 'onMessageWritten';

/** Every document trigger: its path pattern and handler name. */
export const DOC_TRIGGERS = {
  onTicketWritten: 'boards/{boardId}/tickets/{ticketId}',
  onMessageWritten: 'boards/{boardId}/tickets/{ticketId}/messages/{messageId}',
} as const satisfies Record<DocTriggerName, string>;

/** 'boards/{boardId}/tickets/{ticketId}' vs a path → params, or null. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const m = /^\{(\w+)\}$/.exec(p[i]!);
    if (m) params[m[1]!] = s[i]!;
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

function snapshotOf(path: string, data: Record<string, unknown> | undefined) {
  const ref = sqliteDb().doc(path);
  // The change carries the encoded document; read it back through a snapshot for decoding.
  const decoded = data === undefined ? undefined : sqliteDb().decodeDoc(path, data);
  return {
    exists: data !== undefined,
    id: ref.id,
    ref,
    data: () => decoded,
    get: (f: string) => decoded?.[f],
  };
}

function dispatch(changes: DocChange[]): void {
  for (const change of changes) {
    for (const [name, pattern] of Object.entries(DOC_TRIGGERS) as [DocTriggerName, string][]) {
      const params = matchPattern(pattern, change.path);
      if (!params) continue;
      const handler = getTrigger(name) as TriggerHandlers[DocTriggerName] | undefined;
      if (!handler) continue;
      const event = {
        id: change.id,
        time: new Date(change.time).toISOString(),
        params,
        data: {
          before: snapshotOf(change.path, change.before),
          after: snapshotOf(change.path, change.after),
        },
      } as unknown as Parameters<TriggerHandlers[DocTriggerName]>[0];
      setImmediate(() => {
        (handler as (e: unknown) => Promise<void>)(event).catch((e) =>
          console.error(`[trigger] ${name} ${change.path} failed`, e),
        );
      });
    }
  }
}

let installed = false;

/** Deliver document triggers from the store's change feed (no-op on Firestore). */
export function installDbTriggers(): void {
  if (installed || dbKind() !== 'sqlite') return;
  installed = true;
  sqliteDb().onChange(dispatch);
}
