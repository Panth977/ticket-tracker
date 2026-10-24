/**
 * TaskManager's IceBase schema: every collection the backend reads or writes, its document
 * shape (from the shared zod schemas — DOC_SCHEMAS — so there is one source of truth) and
 * every index its queries use (indexes.ts). IceBase validates each write against it and
 * refuses a query whose index is not declared, on Firebase and on the VM alike.
 *
 * A collection whose documents have no zod schema yet is declared open (any keys).
 */
import { collection, defineSchema, f, type AnyCollection, type Field, type FieldMap } from '@panth977/icebase/schema';
import { zodDocument } from '@panth977/icebase/zod';
import { DOC_SCHEMAS } from '@tm/shared';
import type { z } from 'zod';
import { INDEXES } from './indexes.js';

type Name = keyof typeof DOC_SCHEMAS;

/** path template → the zod schema of its documents (null: open). */
const COLLECTIONS: Record<string, Name | null> = {
  users: 'users',
  'users/{uid}/devices': 'devices',
  'users/{uid}/inbox': 'inbox',
  'users/{uid}/reads': 'reads',
  'users/{uid}/apiKeys': 'apiKeys',
  'users/{uid}/oauthGrants': 'oauthGrants',
  'users/{uid}/workspaces': null,
  'users/{uid}/ui': null,
  handles: null,
  orgs: null,
  agents: 'agents',
  'agentInbox/{agentId}/events': 'agentInbox',
  agentInbox: null,
  invites: 'invites',
  boardKeys: 'boardKeys',
  boards: 'boards',
  'boards/{boardId}/members': 'members',
  'boards/{boardId}/prefs': 'prefs',
  'boards/{boardId}/views': 'views',
  'boards/{boardId}/templates': 'templates',
  'boards/{boardId}/stats': 'stats',
  'boards/{boardId}/aggStats': 'aggStats',
  'boards/{boardId}/agentStatus': 'agentStatus',
  'boards/{boardId}/webhooks': 'webhooks',
  'boards/{boardId}/webhooks/{webhookId}/deliveries': 'webhookDeliveries',
  'boards/{boardId}/integrations': 'installs',
  'boards/{boardId}/tickets': 'tickets',
  'boards/{boardId}/tickets/{ticketId}/messages': 'messages',
  'boards/{boardId}/tickets/{ticketId}/activity': 'activity',
  'boards/{boardId}/tickets/{ticketId}/files': 'files',
  'boards/{boardId}/tickets/{ticketId}/tasklists': 'tasklists',
  'boards/{boardId}/tickets/{ticketId}/data': 'ticketData',
  keys: 'keys',
  artifacts: 'artifacts',
  'artifacts/{artifactId}/builds': 'artifactBuilds',
  'artifacts/{artifactId}/viewers': null,
  'artifacts/{artifactId}/viewers/{uid}/kv': 'artifactKv',
  buckets: 'buckets',
  'buckets/{bucketId}/nodes': 'bucketNodes',
  dictionaries: 'dictionaries',
  'dictionaries/{dictionaryId}/content': 'dictionaryContent',
  oauthClients: 'oauthClients',
  oauthTokens: 'oauthTokens',
  intakes: 'intakes',
  deliveries: 'deliveries',
  emailThreads: 'emailThreads',
  whatsappSessions: 'whatsappSessions',
  'boards/{boardId}/driveRev': null,
  'dictionaries/{dictionaryId}/driveRev': null,
  'artifacts/{artifactId}/driveRev': null,
  _driveLinks: null,
  _driveVaults: null,
  _config: null,
  _tasks: null,
  _cron: null,
  _whatsappOtp: null,
  memories: null,
  'memories/{memoryId}/nodes': null,
  // vm: local identity (identity/local) — server-only.
  _authUsers: null,
  _authEmails: null,
  _authLinks: null,
  _authOauth: null,
  _authProviders: null,
  _authSessions: null,
  _idem: null,
  _jobs: null,
  _triggerEvents: null,
  _env: null,
  _dev: null,
  '_dev/{doc}/items': null,
};

/** Collections queried with collectionGroup(). */
const GROUPS = new Set([
  'boards/{boardId}/tickets',
  'boards/{boardId}/members',
  'users/{uid}/inbox',
  'users/{uid}/apiKeys',
  'agentInbox/{agentId}/events',
  'boards/{boardId}/webhooks/{webhookId}/deliveries',
  'deliveries',
  'boards/{boardId}/tickets/{ticketId}/messages',
  'boards/{boardId}/tickets/{ticketId}/files',
  'boards/{boardId}/tickets/{ticketId}/tasklists',
  'boards/{boardId}/tickets/{ticketId}/data',
]);

const open: { fields: FieldMap; rest?: Field<unknown> } = { fields: {}, rest: f.any() };

/**
 * Artifact data: collections the artifact's own code defines, at any depth, with any fields.
 * Single-field queries are served without declarations (like Firestore's automatic indexes).
 */
const artifactData = collection('artifacts/{artifactId}/db/{path=**}', { ...open, indexes: [], autoIndex: true } as never);

/**
 * Where the stored document differs from its zod schema. A board whose tickets live in Google
 * Drive keeps its settings there (db/drive/entities.ts settingsFields): the database copy has none.
 */
const OPTIONAL: Record<string, string[]> = {
  boards: ['stages', 'priorities', 'tags', 'fields', 'defaultViewId', 'settings'],
};

function declare(path: string, name: Name | null): AnyCollection {
  const shape = name ? zodDocument(DOC_SCHEMAS[name] as z.ZodTypeAny) : { ...open, fields: { ...open.fields } };
  for (const k of OPTIONAL[path] ?? []) if (shape.fields[k]) shape.fields[k] = f.optional(shape.fields[k]);
  const group = GROUPS.has(path);
  // An index on a field the document does not have is a mistake in indexes.ts: say so, drop it.
  const indexes = (INDEXES[path] ?? []).filter((ix) => {
    try {
      collection(path, { ...shape, indexes: [ix], group } as never);
      return true;
    } catch (e) {
      console.warn(`[icebase] ${(e as Error).message} — index dropped`);
      return false;
    }
  });
  return collection(path, { ...shape, indexes, group } as never);
}

export const schema = defineSchema({
  ...Object.fromEntries(Object.entries(COLLECTIONS).map(([p, n]) => [p, declare(p, n)])),
  artifactData,
});
