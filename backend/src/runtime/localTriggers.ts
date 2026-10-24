/**
 * TRIGGERS WITHOUT CLOUD FUNCTIONS — document writes and stored objects.
 *
 * On Firebase, Cloud Functions deliver onDocumentWritten and
 * onObjectFinalized events (index.ts registers them). A store without that
 * service announces each change itself — SQLite its committed documents
 * (db/sqlite), the disk store its written objects (blob/disk) — and
 * installLocalTriggers() turns those announcements into the SAME events for
 * the SAME handlers: onTicketWritten, onMessageWritten and
 * onAttachmentFinalized neither know nor care what fired them.
 *
 * Delivery matches the Firebase contract: after the write, asynchronously,
 * with a unique event id (handlers dedupe on it).
 */
import { randomUUID } from 'node:crypto';
import { blobKind } from '../blob/index.js';
import { onFinalize } from '../blob/disk.js';
import type { FinalizedObject } from '../blob/types.js';
import { changeSnapshot, onDocChanges, type DocChange } from '../db/changes.js';
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

const snapshotOf = changeSnapshot;

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

function finalized(obj: FinalizedObject): void {
  const handler = getTrigger('onAttachmentFinalized');
  if (!handler) return;
  const event = {
    id: randomUUID(),
    time: new Date().toISOString(),
    type: 'google.cloud.storage.object.v1.finalized',
    source: 'tm/blob/disk',
    specversion: '1.0',
    data: obj,
  } as unknown as Parameters<TriggerHandlers['onAttachmentFinalized']>[0];
  setImmediate(() => {
    handler(event).catch((e) =>
      console.error(`[trigger] onAttachmentFinalized ${obj.name} failed`, e),
    );
  });
}

let installed = false;

/** Deliver triggers from the local stores' change feeds (each a no-op on its Firebase twin). */
export function installLocalTriggers(): void {
  if (installed) return;
  installed = true;
  onDocChanges(dispatch);
  if (blobKind() === 'disk') onFinalize(finalized);
}
