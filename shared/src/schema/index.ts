import type { z } from 'zod';
import { ArtifactBuildSchema, ArtifactKvSchema, ArtifactSchema } from '../artifacts/schema.js';
import { AgentInboxEventSchema, AgentSchema } from './agent.js';
import {
  BoardKeyClaimSchema,
  BoardMemberSchema,
  BoardPrefSchema,
  BoardSchema,
  BoardDayStatsSchema,
  IntegrationSchema,
  InviteSchema,
  ViewSchema,
  WebhookDeliverySchema,
  WebhookSchema,
} from './board.js';
import {
  DeliverySchema,
  EmailThreadSchema,
  IntakeSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  WhatsappSessionSchema,
} from './platform.js';
import { PresenceSchema, TicketDocSchema, TypingSchema } from './realtime.js';
import {
  ActivitySchema,
  KeyIndexSchema,
  MessageSchema,
  TicketDataPageSchema,
  TicketFileSchema,
  TicketSchema,
} from './ticket.js';
import { TasklistSchema } from './tasklist.js';
import { AgentStatusSchema } from './agentStatus.js';
import { SidebarPrefsSchema, WorkspaceSchema } from './workspace.js';
import { AggStatsSchema } from './aggregates.js';
import { MemoryNodeSchema, MemorySchema } from '../memory/schema.js';
import {
  ApiKeySchema,
  DeviceSchema,
  InboxItemSchema,
  OAuthGrantSchema,
  ReadSchema,
  UserSchema,
} from './user.js';

export * from './user.js';
export * from './board.js';
export * from './aggregates.js';
export * from './ticket.js';
export * from './platform.js';
export * from './realtime.js';
export * from './agent.js';
export * from './question.js';
export * from './tasklist.js';
export * from './agentStatus.js';
export * from './workspace.js';

/**
 * Every stored entity, keyed by its name in docs/data/{app,platform}/db.json
 * `schema` (Storage `attachments` is a file, not a document; `rateLimits` is a
 * bare counter — see RateCountSchema). Used by converters and the fixture tests.
 */
export const DOC_SCHEMAS = {
  users: UserSchema,
  devices: DeviceSchema,
  inbox: InboxItemSchema,
  reads: ReadSchema,
  invites: InviteSchema,
  boardKeys: BoardKeyClaimSchema,
  boards: BoardSchema,
  members: BoardMemberSchema,
  prefs: BoardPrefSchema,
  views: ViewSchema,
  tickets: TicketSchema,
  /**
   * Phase 15 (§W): messages, activity and files are FIELDS of the ticket now.
   * Their schemas stay named here — the converters and the fixture tests check
   * one row at a time, and the migration script reads the old subcollections.
   */
  messages: MessageSchema,
  activity: ActivitySchema,
  files: TicketFileSchema,
  /** boards/{b}/tickets/{t}/data/{NNN} — spilled older messages / activity. */
  ticketData: TicketDataPageSchema,
  /** boards/{b}/stats/{yyyy-mm-dd} — phase 17 (§Y2), the day's cost. */
  stats: BoardDayStatsSchema,
  /** boards/{b}/aggStats/{period}:{key} — aggregates.html, the period buckets. */
  aggStats: AggStatsSchema,
  keys: KeyIndexSchema,
  presence: PresenceSchema,
  typing: TypingSchema,
  'tickets index': TicketDocSchema,
  apiKeys: ApiKeySchema,
  oauthClients: OAuthClientSchema,
  oauthGrants: OAuthGrantSchema,
  oauthTokens: OAuthTokenSchema,
  webhooks: WebhookSchema,
  webhookDeliveries: WebhookDeliverySchema,
  installs: IntegrationSchema,
  intakes: IntakeSchema,
  deliveries: DeliverySchema,
  emailThreads: EmailThreadSchema,
  whatsappSessions: WhatsappSessionSchema,
  // phase 2 (docs/plan/agents.html)
  agents: AgentSchema,
  agentInbox: AgentInboxEventSchema,
  // phase 3 (docs/plan/agents.html §L)
  tasklists: TasklistSchema,
  agentStatus: AgentStatusSchema,
  // artifacts (docs/plan/artifacts.html §G) — the shapes live in ../artifacts/schema.ts
  artifacts: ArtifactSchema,
  /** artifacts/{id}/builds/{buildId} */
  artifactBuilds: ArtifactBuildSchema,
  /** artifacts/{id}/viewers/{uid}/kv/{key} — written by the host page as the viewer. */
  artifactKv: ArtifactKvSchema,
  // workspaces (docs/plan/agents.html §AB) — a person's own sidebar
  /** users/{uid}/workspaces/{workspaceId} */
  workspaces: WorkspaceSchema,
  /** users/{uid}/ui/sidebar */
  sidebarPrefs: SidebarPrefsSchema,
  // memory (docs/plan/memory.html)
  /** memories/{memoryId} */
  memories: MemorySchema,
  /** memories/{memoryId}/nodes/{nodeId} */
  memoryNodes: MemoryNodeSchema,
} as const satisfies Record<string, z.ZodTypeAny>;
export type DocName = keyof typeof DOC_SCHEMAS;
export type DocOf<N extends DocName> = z.infer<(typeof DOC_SCHEMAS)[N]>;
