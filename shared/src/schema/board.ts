/**
 * Board-level documents: invites, boardKeys, boards and their subcollections
 * (members, prefs, views, webhooks, integrations).
 */
import { z } from 'zod';
import { CostCounterSchema } from './message.js';
import {
  AgentIconIdSchema,
  BoardIdSchema,
  BoardKeySchema,
  BoardNotifyPrefSchema,
  BoardRoleSchema,
  ColorSchema,
  FieldDefSchema,
  FilterNodeSchema,
  MillisSchema,
  OptionSchema,
  PrincipalKindSchema,
  isAgentId,
  RichTextSchema,
  StageGrantSchema,
  StageSchema,
  StoragePathSchema,
  TicketIdSchema,
  TicketStateSchema,
  PrincipalIdSchema,
  UidSchema,
  ViewTypeSchema,
  WebhookEventSchema,
  AgentIdSchema,
} from '../types/index.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import { BoardAttachMemorySchema } from '../memory/attach.js';
import { AggCountersSchema, AggFieldDefSchema } from './aggregates.js';
import { DescriptionSchema, IndicatorSchema } from '../types/indicator.js';

export const INVITE_STATUSES = ['pending', 'accepted', 'declined', 'revoked', 'expired'] as const;
/** Invites expire after 14 days. */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * invites/{inviteId} — TOP-LEVEL, because the question is 'what have I been
 * invited to' across boards. The emailed token is never stored, only its SHA-256.
 */
export const InviteSchema = z.object({
  boardId: BoardIdSchema,
  /** The invitee can't read the board yet. */
  boardName: z.string(),
  boardKey: BoardKeySchema,
  /** Lower-cased. */
  email: z
    .string()
    .email()
    .refine((e) => e === e.toLowerCase(), 'Invite emails are lower-cased'),
  role: BoardRoleSchema,
  invitedBy: UidSchema,
  invitedByName: z.string(),
  message: z.string().max(1000).nullable(),
  tokenHash: z.string().min(1),
  status: z.enum(INVITE_STATUSES),
  expiresAt: MillisSchema,
  createdAt: MillisSchema,
  /**
   * ARTIFACT INVITES (docs/plan/artifacts.html §B) ride the same collection:
   * when this is set the invite is to an ARTIFACT, `role` is 'editor' or
   * 'viewer', `boardName` holds the artifact's name, and boardId / boardKey
   * are the fixed ARTIFACT_INVITE_BOARD_ID / _KEY (an artifact has no board).
   */
  artifactId: ArtifactIdSchema.optional(),
});
export type Invite = z.infer<typeof InviteSchema>;

/**
 * boardKeys/{key} — the uniqueness claim, created in the boardCreate
 * transaction. Kept as a tombstone when the board is deleted.
 */
export const BoardKeyClaimSchema = z.object({
  boardId: BoardIdSchema,
  claimedAt: MillisSchema,
  /** Board deleted: the key stays claimed so old #links say 'deleted'. */
  deleted: z.boolean().optional(),
});
export type BoardKeyClaim = z.infer<typeof BoardKeyClaimSchema>;

export const BoardSettingsSchema = z.object({
  /** Hard delete opt-in (reference). */
  allowDelete: z.boolean(),
  /** Replying to a mail posts a comment. */
  emailReplies: z.boolean(),
  autoArchiveDoneAfterDays: z.number().int().positive().nullable(),
  /** inviteCreate: editors may invite too (otherwise admin only). */
  editorsCanInvite: z.boolean().optional(),
});
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;

/**
 * boards/{boardId}. A BOARD IS PRIVATE TO ITS PEOPLE. `access` is THE
 * authority; readerUids / editorUids are derived from it so rules can prove
 * list queries with array-contains.
 */
export const BoardSchema = z.object({
  name: z.string().min(1).max(80),
  key: BoardKeySchema,
  /** allocateKey increments in a transaction. */
  nextNumber: z.number().int().positive(),
  /** LEGACY (indicators.html): read through indicatorOf(); new writes set `indicator`. */
  color: ColorSchema,
  /** LEGACY: a typed icon. */
  icon: z.string(),
  /** indicators.html: what the sidebar, dropdowns and cards draw. Absent on old boards until migrated. */
  indicator: IndicatorSchema.optional(),
  /**
   * indicators.html: plain text (Markdown allowed), mostly for agents. Old
   * boards hold rich text here until scripts/migrate-indicators.mjs flattens it.
   */
  description: z.union([DescriptionSchema, RichTextSchema]).nullable(),

  /** Keys are PRINCIPAL ids: people and agents (§AA2: an agent may hold any role, admin included). */
  access: z.record(PrincipalIdSchema, BoardRoleSchema),
  /** Per person, commenters only. */
  stageGrants: z.record(PrincipalIdSchema, StageGrantSchema),
  /** Derived: every PERSON with any role (never agents — they never sign in to Firebase). */
  readerUids: z.array(UidSchema),
  /** Derived: editor + admin people (never agents). */
  editorUids: z.array(UidSchema),
  /**
   * §AA1 — Derived: every AGENT with any role, like readerUids for people
   * (which still never holds an agent). It exists for one query: "every board
   * this agent is on" is `agentIds array-contains agentId`, which is how an
   * agent token finds its boards at each call. Absent on boards written
   * before §AA until scripts/migrate-agent-tokens.mjs backfills it.
   */
  agentIds: z.array(AgentIdSchema).optional(),

  stages: z.array(StageSchema).min(1),
  priorities: z.array(OptionSchema),
  tags: z.array(OptionSchema),
  fields: z.array(FieldDefSchema),
  defaultViewId: z.string(),

  settings: BoardSettingsSchema,
  /** overdue is kept true by deadlineSweep, not by writes. */
  counts: z.object({
    active: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
  }),
  /** Phase 17 (§Y2): every turn receipt on every ticket, for the board's lifetime. Absent = nothing yet. */
  cost: CostCounterSchema.optional(),
  /** aggregates.html: the aggregate fields (Settings › Aggregates). Absent = none yet (the migration adds Cost). */
  aggFields: z.array(AggFieldDefSchema).optional(),
  /** aggregates.html: lifetime { total, count } per field. `cost` is the legacy mirror of aggs.cost. */
  aggs: AggCountersSchema.optional(),
  /**
   * memory.html §J: where a file put on one of this board's tickets goes by
   * default — one of the memories granted `write` to the board, and a path
   * template. Absent / null = none set (the attach dialog asks). Set by
   * boardAttachMemorySet; cleared when that memory's write grant goes.
   */
  attachMemory: BoardAttachMemorySchema.nullable().optional(),
  /** boardArchive: read-only, hidden from the sidebar, restorable. */
  archivedAt: MillisSchema.nullable(),
  createdBy: UidSchema,
  createdAt: MillisSchema,
});
export type Board = z.infer<typeof BoardSchema>;

/**
 * Phase 17 (§Y2): the day a cost lands on is cut in the OWNER's clock, by a
 * constant and not a setting (decision D-Y1: one owner). Day ids are
 * 'yyyy-mm-dd' in this zone, so they sort as strings.
 */
export const COST_DAY_TZ = 'Asia/Kolkata';
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: COST_DAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** 'yyyy-mm-dd' of a moment, in COST_DAY_TZ. */
export const costDayOf = (millis: number): string => dayFmt.format(new Date(millis));

/**
 * boards/{b}/stats/{yyyy-mm-dd} — one row per day a receipt landed on. Written
 * by messagePost in the same transaction as the receipt; read by the Analytics
 * view (§Y3), at most ~90 rows at a time. Readable by the board's readers.
 */
export const BoardDayStatsSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  costUsd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
  /** ticket KEY → its share of the day. */
  tickets: z.record(z.string(), CostCounterSchema),
  updatedAt: MillisSchema,
});
export type BoardDayStats = z.infer<typeof BoardDayStatsSchema>;
/** A board with its document id, as commands and can() see it. */
export type BoardWithId = Board & { id: string };

/**
 * boards/{boardId}/members/{principalId} — the board's people AND agents,
 * denormalised for pickers. `access` on the board is the authority.
 *
 * Phase 2 (agents.html §C): `kind` says which. Stored docs from phase 1 have no
 * `kind` and parse as 'user'. An agent row is
 *   { kind: 'agent', uid: agentId, role, stageGrant, name, avatarPath, ownerUid, addedBy, joinedAt }
 * with email '' and invitedBy null (agents are added directly, never invited).
 * §AA2: an agent may be 'admin' (the old "never admin" rule is gone).
 */
const BoardMemberObject = z.object({
  /** 'user' | 'agent'. Absent on phase-1 docs = 'user'. */
  kind: PrincipalKindSchema.default('user'),
  /** Also the doc id (a principal id: uid or 'ag_…'); a field so collectionGroup can find it. */
  uid: PrincipalIdSchema,
  role: BoardRoleSchema,
  /** Commenters only. */
  stageGrant: StageGrantSchema.nullable(),
  name: z.string(),
  /** '' for agents. */
  email: z.string(),
  /** users/{uid}/avatar/… or, for an agent, users/{ownerUid}/agents/{agentId}/avatar/… */
  avatarPath: StoragePathSchema.nullable(),
  /** Agents only: the prebuilt icon (types/agentIcons), copied from the profile like avatarPath. */
  icon: AgentIconIdSchema.nullable().optional(),
  /** null for the board's creator, and for agents. */
  invitedBy: UidSchema.nullable(),
  /** Agents only: the person who owns the agent profile. */
  ownerUid: UidSchema.optional(),
  /** Agents only: the board admin (the owner) who added it. */
  addedBy: UidSchema.optional(),
  /** Agents only: its one-line description, shown in pickers. */
  description: z.string().max(200).nullable().optional(),
  joinedAt: MillisSchema,
});
export const BoardMemberSchema = BoardMemberObject.superRefine((m, ctx) => {
  const agent = isAgentId(m.uid);
  if (m.kind === 'agent') {
    if (!agent)
      ctx.addIssue({
        code: 'custom',
        path: ['uid'],
        message: "An agent member's id starts with 'ag_'",
      });
    if (!m.ownerUid)
      ctx.addIssue({ code: 'custom', path: ['ownerUid'], message: 'Agent members carry ownerUid' });
    if (!m.addedBy)
      ctx.addIssue({ code: 'custom', path: ['addedBy'], message: 'Agent members carry addedBy' });
  } else if (agent) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: "An 'ag_' id is an agent" });
  }
});
/** The plain object schema (no cross-field checks) — for .pick / .extend. */
export const BoardMemberBaseSchema = BoardMemberObject;
export type BoardMember = z.infer<typeof BoardMemberSchema>;
/** The input side: `kind` may be omitted (phase-1 docs). */
export type BoardMemberInput = z.input<typeof BoardMemberSchema>;

/**
 * Roles an agent may hold on a board. §AA2: ALL of them — 'admin' is new for
 * agents ("complete ownership": board settings, stages, fields, webhooks,
 * restore). What an agent admin still cannot do is what no agent can: manage
 * the board's people and agents, invite, create boards, mint tokens.
 */
export const AGENT_BOARD_ROLES = ['admin', 'editor', 'commenter', 'viewer'] as const;
export const AgentBoardRoleSchema = z.enum(AGENT_BOARD_ROLES);
export type AgentBoardRole = z.infer<typeof AgentBoardRoleSchema>;

/** boards/{boardId}/prefs/{uid} — one per person per board; nobody sets anyone else's. */
export const BoardPrefSchema = BoardNotifyPrefSchema.extend({
  /** Always notify for these ('subscribed' in the reference). */
  watching: z.array(TicketIdSchema),
  /** Pinned in the sidebar. */
  starred: z.boolean(),
  lastViewId: z.string(),
});
export type BoardPref = z.infer<typeof BoardPrefSchema>;

export const ViewSortSchema = z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) });
export const ViewColumnSchema = z.object({
  field: z.string(),
  width: z.number().positive(),
  hidden: z.boolean().optional(),
});

/** boards/{boardId}/views/{viewId} — personal and shared views in one collection. */
export const ViewSchema = z.object({
  name: z.string().min(1).max(60),
  type: ViewTypeSchema,
  scope: z.enum(['shared', 'personal']),
  ownerUid: UidSchema,
  position: z.number(),
  filter: FilterNodeSchema.nullable(),
  sort: z.array(ViewSortSchema),
  /** 'stage' | 'priority' | 'assignee' | 'tag' | `fields.${id}` */
  groupBy: z.string().nullable(),
  /** Swimlanes. */
  subGroupBy: z.string().nullable(),
  /** Table. */
  columns: z.array(ViewColumnSchema),
  /** Calendar / timeline: 'due' | 'start' | `fields.${id}` */
  dateField: z.string().nullable(),
  /** Timeline bar end. */
  endDateField: z.string().nullable(),
  /** What a kanban card shows. */
  cardFields: z.array(z.string()),
  /** Default ['active']. */
  includeStates: z.array(TicketStateSchema).min(1),
});
export type View = z.infer<typeof ViewSchema>;

/** boards/{boardId}/webhooks/{webhookId} — admins only. */
export const WebhookSchema = z.object({
  /** https only; private IPs refused (SSRF). */
  url: z.string().url().startsWith('https://'),
  secretHash: z.string().min(1),
  /** Server-only: the signing secret is HMAC(server key, board/webhook/nonce); rotating changes the nonce. */
  secretNonce: z.string().optional(),
  events: z.array(WebhookEventSchema).min(1),
  active: z.boolean(),
  /** Consecutive; 20 → disabled + owner emailed. */
  failures: z.number().int().nonnegative(),
  createdBy: UidSchema,
  createdAt: MillisSchema,
});
export type Webhook = z.infer<typeof WebhookSchema>;
export const WEBHOOK_MAX_FAILURES = 20;

/** boards/{boardId}/webhooks/{webhookId}/deliveries/{deliveryId} — TTL 30 days. */
export const WebhookDeliverySchema = z.object({
  event: WebhookEventSchema.or(z.literal('ping')),
  envelopeId: z.string(),
  attempt: z.number().int().positive(),
  status: z.enum(['pending', 'ok', 'failed', 'gave_up']),
  responseCode: z.number().int().nullable(),
  /** First 500 bytes — for the 'Recent deliveries' panel. */
  responseSnippet: z.string().max(500),
  durationMs: z.number().nonnegative(),
  nextAttemptAt: MillisSchema.nullable(),
  createdAt: MillisSchema,
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const INTEGRATION_PROVIDERS = ['github', 'slack', 'gcal', 'gitlab'] as const;
export const IntegrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

/**
 * boards/{boardId}/integrations/{provider} ("installs"). Provider tokens live
 * in Secret Manager under integrations/{boardId}/{provider}, never here.
 */
export const IntegrationSchema = z.object({
  provider: IntegrationProviderSchema,
  status: z.enum(['active', 'error', 'removed']),
  /** GitHub installation id, Slack workspace id. */
  externalId: z.string(),
  config: z.object({
    /** github: repos linked to THIS board; moveOnMerge = stage id. */
    repos: z
      .array(z.object({ fullName: z.string(), moveOnMerge: z.string().optional() }))
      .optional(),
    /** slack: where this board posts. */
    channelId: z.string().optional(),
    events: z.array(WebhookEventSchema).optional(),
  }),
  connectedBy: UidSchema,
  connectedAt: MillisSchema,
});
export type Integration = z.infer<typeof IntegrationSchema>;
