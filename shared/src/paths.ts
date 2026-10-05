/**
 * Every location the system reads or writes, built in one place so a typo in
 * a path is a compile error, not an empty query.
 *
 *   COLLECTIONS  — collection ids (for collectionGroup queries too)
 *   paths        — Firestore document / collection paths
 *   rtdb         — Realtime Database paths
 *   storage      — Cloud Storage object paths and prefixes
 */

export const COLLECTIONS = {
  users: 'users',
  devices: 'devices',
  inbox: 'inbox',
  reads: 'reads',
  apiKeys: 'apiKeys',
  oauthGrants: 'oauthGrants',
  invites: 'invites',
  boardKeys: 'boardKeys',
  boards: 'boards',
  members: 'members',
  prefs: 'prefs',
  views: 'views',
  tickets: 'tickets',
  messages: 'messages',
  activity: 'activity',
  files: 'files',
  keys: 'keys',
  webhooks: 'webhooks',
  deliveries: 'deliveries',
  integrations: 'integrations',
  oauthClients: 'oauthClients',
  oauthTokens: 'oauthTokens',
  intakes: 'intakes',
  emailThreads: 'emailThreads',
  whatsappSessions: 'whatsappSessions',
  /** Phase 2: agent profiles (agents.html §B). */
  agents: 'agents',
  /** Phase 2: agentInbox/{agentId}/events/{eventId} (§D). */
  agentInbox: 'agentInbox',
  events: 'events',
  /**
   * Phase 3: boards/{b}/tickets/{t}/tasklists/{listId} (§L2). Phase 15 (§W)
   * folded task lists INTO the ticket document; the id survives for the
   * migration script and for rules that still have to deny the old path.
   */
  tasklists: 'tasklists',
  /**
   * Phase 15 (§W): boards/{b}/tickets/{t}/data/{NNN} — a frozen page of older
   * messages / activity that spilled out of the ticket document.
   */
  data: 'data',
  /** Phase 3: boards/{b}/agentStatus/{agentId}__{ticketId|'_'} (§L3). */
  agentStatus: 'agentStatus',
  /** Phase 17 (§Y2): boards/{b}/stats/{yyyy-mm-dd} — the day's turn receipts, summed. */
  stats: 'stats',
  /** Artifacts (artifacts.html §G): artifacts/{id}, its builds, its viewers' kv. */
  artifacts: 'artifacts',
  builds: 'builds',
  viewers: 'viewers',
  /** §AB: users/{uid}/workspaces/{id} — a person's own bundles of boards and artifacts. */
  workspaces: 'workspaces',
  /** §AB: users/{uid}/ui/{doc} — the person's own UI state ('sidebar'). */
  ui: 'ui',
  /** Command idempotency records: _idem/{uid}_{clientId}, 24h TTL. */
  idem: '_idem',
  /** Long-running job parameters (accountExport's queued job). Server-only. */
  jobs: '_jobs',
  /** Once-only markers for trigger side effects (search counts). Server-only. */
  triggerEvents: '_triggerEvents',
} as const;
export type CollectionId = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

const C = COLLECTIONS;

/**
 * §W page ids are zero-padded ('000', '001', …) so that a string sort over
 * boards/{b}/tickets/{t}/data is a chronological sort. Kept here (and
 * re-exported by schema/ticket.ts) because a path needs it.
 */
export const pageId = (n: number): string => String(n).padStart(3, '0');

/** Guard against ids that would change the shape of a path. */
function seg(id: string): string {
  if (!id || id.includes('/') || id === '.' || id === '..') {
    throw new Error(`Invalid path segment: ${JSON.stringify(id)}`);
  }
  return id;
}

export const paths = {
  // users/{uid} and below
  users: () => C.users,
  user: (uid: string) => `${C.users}/${seg(uid)}`,
  devices: (uid: string) => `${C.users}/${seg(uid)}/${C.devices}`,
  device: (uid: string, deviceId: string) => `${C.users}/${seg(uid)}/${C.devices}/${seg(deviceId)}`,
  inbox: (uid: string) => `${C.users}/${seg(uid)}/${C.inbox}`,
  inboxItem: (uid: string, notificationId: string) =>
    `${C.users}/${seg(uid)}/${C.inbox}/${seg(notificationId)}`,
  reads: (uid: string) => `${C.users}/${seg(uid)}/${C.reads}`,
  read: (uid: string, ticketId: string) => `${C.users}/${seg(uid)}/${C.reads}/${seg(ticketId)}`,
  apiKeys: (uid: string) => `${C.users}/${seg(uid)}/${C.apiKeys}`,
  apiKey: (uid: string, keyId: string) => `${C.users}/${seg(uid)}/${C.apiKeys}/${seg(keyId)}`,
  oauthGrants: (uid: string) => `${C.users}/${seg(uid)}/${C.oauthGrants}`,
  oauthGrant: (uid: string, grantId: string) =>
    `${C.users}/${seg(uid)}/${C.oauthGrants}/${seg(grantId)}`,
  workspaces: (uid: string) => `${C.users}/${seg(uid)}/${C.workspaces}`,
  workspace: (uid: string, workspaceId: string) =>
    `${C.users}/${seg(uid)}/${C.workspaces}/${seg(workspaceId)}`,
  sidebarPrefs: (uid: string) => `${C.users}/${seg(uid)}/${C.ui}/sidebar`,

  // top-level
  invites: () => C.invites,
  invite: (inviteId: string) => `${C.invites}/${seg(inviteId)}`,
  boardKeys: () => C.boardKeys,
  boardKey: (key: string) => `${C.boardKeys}/${seg(key)}`,
  keys: () => C.keys,
  key: (ticketKey: string) => `${C.keys}/${seg(ticketKey)}`,
  oauthClients: () => C.oauthClients,
  oauthClient: (clientId: string) => `${C.oauthClients}/${seg(clientId)}`,
  oauthTokens: () => C.oauthTokens,
  /** Doc id is sha256(token), never the token. */
  oauthToken: (tokenHash: string) => `${C.oauthTokens}/${seg(tokenHash)}`,
  job: (jobId: string) => `${C.jobs}/${seg(jobId)}`,
  triggerEvent: (eventId: string) => `${C.triggerEvents}/${seg(eventId)}`,
  intakes: () => C.intakes,
  intake: (slug: string) => `${C.intakes}/${seg(slug)}`,
  deliveries: () => C.deliveries,
  delivery: (deliveryId: string) => `${C.deliveries}/${seg(deliveryId)}`,
  emailThreads: () => C.emailThreads,
  emailThread: (replyToken: string) => `${C.emailThreads}/${seg(replyToken)}`,
  whatsappSessions: () => C.whatsappSessions,
  /** Doc id is the E.164 number, e.g. '+919812345678'. */
  whatsappSession: (e164: string) => `${C.whatsappSessions}/${seg(e164)}`,
  // phase 2: agents and their inbox
  agents: () => C.agents,
  agent: (agentId: string) => `${C.agents}/${seg(agentId)}`,
  agentInbox: (agentId: string) => `${C.agentInbox}/${seg(agentId)}`,
  agentEvents: (agentId: string) => `${C.agentInbox}/${seg(agentId)}/${C.events}`,
  agentEvent: (agentId: string, eventId: string) =>
    `${C.agentInbox}/${seg(agentId)}/${C.events}/${seg(eventId)}`,

  idem: (uid: string, clientId: string) => `${C.idem}/${seg(uid)}_${seg(clientId)}`,

  // boards/{boardId} and below
  boards: () => C.boards,
  board: (boardId: string) => `${C.boards}/${seg(boardId)}`,
  members: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.members}`,
  member: (boardId: string, uid: string) => `${C.boards}/${seg(boardId)}/${C.members}/${seg(uid)}`,
  prefs: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.prefs}`,
  pref: (boardId: string, uid: string) => `${C.boards}/${seg(boardId)}/${C.prefs}/${seg(uid)}`,
  views: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.views}`,
  stats: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.stats}`,
  stat: (boardId: string, day: string) => `${C.boards}/${seg(boardId)}/${C.stats}/${seg(day)}`,
  view: (boardId: string, viewId: string) =>
    `${C.boards}/${seg(boardId)}/${C.views}/${seg(viewId)}`,
  webhooks: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.webhooks}`,
  webhook: (boardId: string, webhookId: string) =>
    `${C.boards}/${seg(boardId)}/${C.webhooks}/${seg(webhookId)}`,
  webhookDeliveries: (boardId: string, webhookId: string) =>
    `${C.boards}/${seg(boardId)}/${C.webhooks}/${seg(webhookId)}/${C.deliveries}`,
  webhookDelivery: (boardId: string, webhookId: string, deliveryId: string) =>
    `${C.boards}/${seg(boardId)}/${C.webhooks}/${seg(webhookId)}/${C.deliveries}/${seg(deliveryId)}`,
  integrations: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.integrations}`,
  integration: (boardId: string, provider: string) =>
    `${C.boards}/${seg(boardId)}/${C.integrations}/${seg(provider)}`,

  // tickets and below
  tickets: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.tickets}`,
  ticket: (boardId: string, ticketId: string) =>
    `${C.boards}/${seg(boardId)}/${C.tickets}/${seg(ticketId)}`,
  messages: (boardId: string, ticketId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.messages}`,
  message: (boardId: string, ticketId: string, messageId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.messages}/${seg(messageId)}`,
  activities: (boardId: string, ticketId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.activity}`,
  activity: (boardId: string, ticketId: string, activityId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.activity}/${seg(activityId)}`,
  files: (boardId: string, ticketId: string) => `${paths.ticket(boardId, ticketId)}/${C.files}`,
  file: (boardId: string, ticketId: string, fileId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.files}/${seg(fileId)}`,
  /**
   * §W overflow pages. `ticketData` is the collection, `ticketPage` one page;
   * the id is zero-padded (pageId) so a string sort is chronological.
   */
  ticketData: (boardId: string, ticketId: string) => `${paths.ticket(boardId, ticketId)}/${C.data}`,
  ticketPage: (boardId: string, ticketId: string, page: number | string) =>
    `${paths.ticket(boardId, ticketId)}/${C.data}/${seg(typeof page === 'number' ? pageId(page) : page)}`,
  // phase 3: task lists on a ticket, heartbeat status on the board
  tasklists: (boardId: string, ticketId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.tasklists}`,
  tasklist: (boardId: string, ticketId: string, listId: string) =>
    `${paths.ticket(boardId, ticketId)}/${C.tasklists}/${seg(listId)}`,
  agentStatuses: (boardId: string) => `${C.boards}/${seg(boardId)}/${C.agentStatus}`,
  /** statusId = agentStatusId(agentId, ticketId | null). */
  agentStatusDoc: (boardId: string, statusId: string) =>
    `${C.boards}/${seg(boardId)}/${C.agentStatus}/${seg(statusId)}`,
} as const;

/**
 * Parse a ticket document path back into ids (collection-group results, triggers).
 * Returns null for anything that is not boards/{b}/tickets/{t}.
 */
export function parseTicketPath(path: string): { boardId: string; ticketId: string } | null {
  const m = /^boards\/([^/]+)\/tickets\/([^/]+)$/.exec(path);
  return m ? { boardId: m[1]!, ticketId: m[2]! } : null;
}

/** Parse a message path: boards/{b}/tickets/{t}/messages/{m}. */
export function parseMessagePath(
  path: string,
): { boardId: string; ticketId: string; messageId: string } | null {
  const m = /^boards\/([^/]+)\/tickets\/([^/]+)\/messages\/([^/]+)$/.exec(path);
  return m ? { boardId: m[1]!, ticketId: m[2]!, messageId: m[3]! } : null;
}

/** Parse a data page path: boards/{b}/tickets/{t}/data/{NNN}. */
export function parseTicketPagePath(
  path: string,
): { boardId: string; ticketId: string; page: number } | null {
  const m = /^boards\/([^/]+)\/tickets\/([^/]+)\/data\/(\d{3,})$/.exec(path);
  return m ? { boardId: m[1]!, ticketId: m[2]!, page: Number(m[3]) } : null;
}

/** Parse a tasklist path: boards/{b}/tickets/{t}/tasklists/{listId}. */
export function parseTasklistPath(
  path: string,
): { boardId: string; ticketId: string; listId: string } | null {
  const m = /^boards\/([^/]+)\/tickets\/([^/]+)\/tasklists\/([^/]+)$/.exec(path);
  return m ? { boardId: m[1]!, ticketId: m[2]!, listId: m[3]! } : null;
}

/** Realtime Database locations. */
export const rtdb = {
  /** presence/{boardId}/{uid} */
  presenceBoard: (boardId: string) => `presence/${seg(boardId)}`,
  presence: (boardId: string, uid: string) => `presence/${seg(boardId)}/${seg(uid)}`,
  /** typing/{boardId}/{ticketId}/{uid} */
  typingTicket: (boardId: string, ticketId: string) => `typing/${seg(boardId)}/${seg(ticketId)}`,
  typing: (boardId: string, ticketId: string, uid: string) =>
    `typing/${seg(boardId)}/${seg(ticketId)}/${seg(uid)}`,
  /** boardReaders/{boardId}/{uid} = true — mirror of readerUids for RTDB rules. */
  boardReaders: (boardId: string) => `boardReaders/${seg(boardId)}`,
  boardReader: (boardId: string, uid: string) => `boardReaders/${seg(boardId)}/${seg(uid)}`,
  /** rate/{bucket}/{window} — bucket like 'key:abc' (':' is legal in RTDB keys). */
  rate: (bucket: string, window: string | number) => `rate/${seg(bucket)}/${seg(String(window))}`,
  rateBucket: (bucket: string) => `rate/${seg(bucket)}`,
} as const;

/** Rate-limit bucket names (platform/db.json rateLimits). */
export const rateBuckets = {
  apiKey: (keyId: string) => `key:${keyId}`,
  /** Per-token event stream connections / polls (GET /v1/events[/stream]). */
  events: (keyId: string) => `events:${keyId}`,
  intake: (slug: string) => `intake:${slug}`,
  ip: (ipHash: string) => `ip:${ipHash}`,
  mcp: (grantId: string) => `mcp:${grantId}`,
  /** inviteCreate: 50 invites per person per day. */
  invites: (uid: string) => `invites:${uid}`,
  /** boardCreate: 10 new boards per person per day. */
  boardCreates: (uid: string) => `boards:${uid}`,
  /** accountExport: 3 exports per person per day. */
  exports: (uid: string) => `exports:${uid}`,
} as const;

export const THUMB_NAME = 'thumb_400.webp';
/** Uploaded files nobody attached are swept after this long. */
export const ORPHAN_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Cloud Storage object paths. */
export const storage = {
  /** Everything belonging to one ticket (used when it is deleted). */
  ticketPrefix: (boardId: string, ticketId: string) =>
    `boards/${seg(boardId)}/tickets/${seg(ticketId)}/`,
  boardPrefix: (boardId: string) => `boards/${seg(boardId)}/`,
  /** boards/{boardId}/tickets/{ticketId}/{attachmentId}/{fileName} */
  attachment: (boardId: string, ticketId: string, attachmentId: string, fileName: string) =>
    `boards/${seg(boardId)}/tickets/${seg(ticketId)}/${seg(attachmentId)}/${seg(fileName)}`,
  /** Written by onAttachmentFinalized next to the original. */
  thumb: (boardId: string, ticketId: string, attachmentId: string) =>
    `boards/${seg(boardId)}/tickets/${seg(ticketId)}/${seg(attachmentId)}/${THUMB_NAME}`,
  avatarPrefix: (uid: string) => `users/${seg(uid)}/avatar/`,
  /** users/{uid}/avatar/{millis}.webp */
  avatar: (uid: string, millis: number) => `users/${seg(uid)}/avatar/${millis}.webp`,
  /** users/{ownerUid}/agents/{agentId}/avatar/ — everything under one agent's picture. */
  agentAvatarPrefix: (ownerUid: string, agentId: string) =>
    `users/${seg(ownerUid)}/agents/${seg(agentId)}/avatar/`,
  /** users/{ownerUid}/agents/{agentId}/avatar/{millis}.webp — uploaded and cropped like a person's. */
  agentAvatar: (ownerUid: string, agentId: string, millis: number) =>
    `users/${seg(ownerUid)}/agents/${seg(agentId)}/avatar/${millis}.webp`,
  /** exports/{uid}/{jobId}.zip — accountExport, signed URL 7 days. */
  export: (uid: string, jobId: string) => `exports/${seg(uid)}/${seg(jobId)}.zip`,
} as const;

/** Parse an agent avatar path: users/{ownerUid}/agents/{agentId}/avatar/{file}. */
export function parseAgentAvatarPath(path: string): { ownerUid: string; agentId: string } | null {
  const m = /^users\/([^/]+)\/agents\/(ag_[A-Za-z0-9]{16})\/avatar\/[^/]+$/.exec(path);
  return m ? { ownerUid: m[1]!, agentId: m[2]! } : null;
}

/** Parse an attachment object path; null when it is not one (e.g. a thumbnail or avatar). */
export function parseAttachmentPath(
  path: string,
): { boardId: string; ticketId: string; attachmentId: string; fileName: string } | null {
  const m = /^boards\/([^/]+)\/tickets\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!m || m[4] === THUMB_NAME) return null;
  return { boardId: m[1]!, ticketId: m[2]!, attachmentId: m[3]!, fileName: m[4]! };
}

/** True when `path` is an attachment under this ticket's prefix (messagePost / ticketCreate check). */
export function isUnderTicket(path: string, boardId: string, ticketId: string): boolean {
  const p = parseAttachmentPath(path);
  return !!p && p.boardId === boardId && p.ticketId === ticketId;
}
