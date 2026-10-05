/**
 * Documents under users/{uid} (app/db.json + platform/db.json `schema`).
 * Stored shapes: the document id is NOT a field unless the spec says so.
 */
import { z } from 'zod';
import {
  BoardIdSchema,
  ChannelMatrixSchema,
  MillisSchema,
  NotifyEventSchema,
  ADMIN_SCOPES,
  isAccountScope,
  isAgentTokenScopes,
  PrincipalRefSchema,
  ScopeListInputSchema,
  ScopeSchema,
  StoragePathSchema,
  TicketIdSchema,
  PrincipalIdSchema,
  UidSchema,
  ViaSchema,
} from '../types/index.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';

export const THEMES = ['system', 'light', 'dark'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const DIGESTS = ['off', 'hourly', 'daily'] as const;

/** 'HH:MM', 24h, in the person's timezone. */
export const HHMMSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const UserNotifySchema = z.object({
  channels: ChannelMatrixSchema,
  quietHours: z.object({ start: HHMMSchema, end: HHMMSchema }).nullable(),
  /** Mentions may break quiet hours 'if the user allowed it' (absent = no). */
  quietHoursAllowMentions: z.boolean().optional(),
  digest: z.enum(DIGESTS),
  /** 'Remind me this long before a due date' — default 1440, at most 72h (deadlineSweep window). */
  dueSoonLeadMinutes: z
    .number()
    .int()
    .min(0)
    .max(72 * 60),
  commitmentReminders: z.boolean(),
});
export type UserNotify = z.infer<typeof UserNotifySchema>;

/** users/{uid} — any signed-in person may GET one; nobody LISTs; written only by commands. */
export const UserSchema = z.object({
  /** Display name — shown everywhere, editable, not unique. */
  name: z.string().min(1).max(60),
  /** From Auth, verified — shown beside the name, changed only via Auth. Empty after accountDelete. */
  email: z.string().max(320),
  /** users/{uid}/avatar/{millis}.webp, 256px */
  avatarPath: StoragePathSchema.nullable(),
  /** IANA zone, 'Asia/Kolkata' */
  timezone: z.string().min(1),
  locale: z.string().min(1),
  theme: ThemeSchema,
  whatsapp: z
    .object({ number: z.string(), verifiedAt: MillisSchema, optIn: z.boolean() })
    .nullable(),
  notify: UserNotifySchema,
  createdAt: MillisSchema,
  /** Soft delete, see accountDelete. */
  deletedAt: MillisSchema.nullable(),
  /**
   * PHASE 16 (§X) — THE ALLOW-LIST MIRROR. The list itself is `_config/allow`
   * (server-owned, unreadable by any client); this flag is the same answer for
   * one person, so firestore.rules and storage.rules can check it in ONE hop
   * and the app's middleware costs one document read.
   *
   * Written by onUserCreated (a new sign-up: is this address on the list?) and
   * by userAllow / userDisallow. ABSENT means "not decided here": documents
   * that predate the allow list, and the ones the emulator suites seed. The
   * rules read it as `allowed != false`, because a document can only be
   * created by a path that was already gated (onUserCreated, or a command
   * behind the middleware) — an explicit `false` is the only refusal.
   */
  allowed: z.boolean().optional(),
});
export type User = z.infer<typeof UserSchema>;

/** Does this profile's mirror refuse the person? (Absent = nothing decided.) */
export const userBlocked = (u: Pick<Partial<User>, 'allowed'> | null | undefined): boolean =>
  u?.allowed === false;

export const DEFAULT_DUE_SOON_LEAD_MINUTES = 1440;

/** users/{uid}/devices/{deviceId} — the one collection a client writes directly. */
export const DeviceSchema = z.object({
  fcmToken: z.string().min(1).max(4096),
  kind: z.enum(['web', 'ios', 'android']),
  userAgent: z.string().max(1024),
  lastSeenAt: MillisSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * users/{uid}/inbox/{notificationId} — THE IN-APP CHANNEL. The owner may only
 * change readAt / archivedAt / snoozedUntil.
 */
export const InboxItemSchema = z.object({
  event: NotifyEventSchema,
  boardId: BoardIdSchema,
  /** null for 'invited' */
  ticketId: TicketIdSchema.nullable(),
  /** Denormalised for rendering. */
  ticketKey: z.string().nullable(),
  ticketTitle: z.string().nullable(),
  /** 'invited': Accept / Decline right in the row. */
  inviteId: z.string().nullable(),
  /** null for dueSoon / overdue; a principal (an agent's actions notify people too). */
  actor: PrincipalIdSchema.nullable(),
  via: ViaSchema,
  /** 'moved to QA', 'mentioned you: …' */
  summary: z.string(),
  /** Deep link into the thread. */
  messageId: z.string().optional(),
  /** `${ticketId}:${event}` — collapses 5 comments into one row. */
  groupKey: z.string().min(1),
  /** How many were collapsed. */
  count: z.number().int().positive(),
  createdAt: MillisSchema,
  readAt: MillisSchema.nullable(),
  archivedAt: MillisSchema.nullable(),
  snoozedUntil: MillisSchema.nullable(),
  /**
   * A row about an ARTIFACT (shared with you, an invite to one, a new build
   * on one you own): boardId is ARTIFACT_INVITE_BOARD_ID and this says which
   * artifact. Absent on every board row.
   */
  artifactId: ArtifactIdSchema.optional(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;
/** Fields the owner may write directly (firestore.rules onlyChanges). */
export const INBOX_CLIENT_FIELDS = ['readAt', 'archivedAt', 'snoozedUntil'] as const;

/** users/{uid}/reads/{ticketId} — UNREAD = ticket.lastMessageAt > readAt. */
/**
 * users/{uid}/reads/{ticketId}. `ticketId` (= the doc id) makes the pointers
 * of one ticket queryable as a collection group, so a thread can show 'Seen
 * by' to people on the board (rules: canRead(boardId)). Absent on old docs.
 */
export const ReadSchema = z.object({
  boardId: BoardIdSchema,
  readAt: MillisSchema,
  ticketId: TicketIdSchema.optional(),
});
export type Read = z.infer<typeof ReadSchema>;
export const READ_CLIENT_FIELDS = ['readAt', 'boardId', 'ticketId'] as const;

/**
 * users/{uid}/apiKeys/{keyId} — API KEY v2 (docs/plan/agents.html §E).
 * ONE BOARD EACH, optionally ACTING AS AN AGENT the owner owns. Stored as a
 * hash, shown once. What it may do = scopes ∩ can() for its principal on
 * `boardId`. Archiving the agent revokes it; removing the agent from the board
 * revokes a (legacy) board token for that board — never a §AA agent token,
 * which belongs to the agent and not to a board.
 *
 * Phase-1 keys (boardIds, no actsAs) are no longer valid documents; the
 * middleware treats a doc that fails this schema as revoked.
 */
/**
 * §AA1 adds the THIRD kind, 'agent': ONE TOKEN PER AGENT. It acts as the
 * agent, has no board of its own (boardId null) and no checkbox list — its
 * scopes are always AGENT_TOKEN_SCOPES. It reaches every board and every
 * artifact the agent is on, as that stands at each call, exactly as an
 * account token does for a person. What it may DO there is the agent's role
 * on that board / its { build, data } on that artifact.
 *
 * A kind 'board' row acting as an agent (every agent token before §AA) is
 * still a valid document and still resolves as before, until
 * scripts/migrate-agent-tokens.mjs converts it (§AA6).
 */
export const API_KEY_KINDS = ['board', 'account', 'agent'] as const;
export const ApiKeyKindSchema = z.enum(API_KEY_KINDS);
export type ApiKeyKind = z.infer<typeof ApiKeyKindSchema>;

export const ApiKeySchema = z
  .object({
    /** 'orch-eng-builder' — shown in 'via token …'. */
    name: z.string().trim().min(1).max(80),
    /**
     * PHASE 10 (§R1). 'board' (the default, and every phase-2 row): one board,
     * acting as the owner or one of their agents. 'account': "virtual me" —
     * boardId is null and the token acts as the owner on EVERY board they are
     * on, as that stands at each call.
     */
    kind: ApiKeyKindSchema.default('board'),
    /** Exactly one board the owner is on; null for an account token and for an agent token (§AA1). */
    boardId: BoardIdSchema.nullable(),
    /**
     * §AA1 / §AA6 — kind 'agent' only, and only on a token that was CONVERTED
     * from an old board token: the board it used to be for. A call that needs
     * a board and names none uses it (when the agent is on several boards and
     * is still on this one), so nothing that ran before the conversion breaks.
     * A freshly generated agent token has none.
     */
    defaultBoardId: BoardIdSchema.nullable().optional(),
    /** Who the token's changes are authored by: the owner, or one of their agents on that board. */
    actsAs: PrincipalRefSchema,
    /** New vocabulary only (TOKEN_SCOPES, + ADMIN_SCOPES / ACCOUNT_SCOPES where allowed). */
    scopes: z.array(ScopeSchema).min(1),
    /** 'tm_live_3fa9' — shown in the list. */
    prefix: z.string().min(1),
    /** sha256 of the full key; queried by the middleware (collectionGroup). */
    hash: z.string().min(1),
    limits: z.object({ perMin: z.number().int().positive(), perDay: z.number().int().positive() }),
    lastUsedAt: MillisSchema.nullable(),
    expiresAt: MillisSchema.nullable(),
    revokedAt: MillisSchema.nullable(),
    /** Why it stopped working — for the Tokens list. */
    revokedReason: z
      // 'rotated' (§AA1): generating a new agent token replaced this one.
      .enum(['owner', 'agentArchived', 'agentRemoved', 'ownerLeft', 'rotated'])
      .nullable()
      .optional(),
    createdAt: MillisSchema,
  })
  .superRefine((k, ctx) => {
    // §AA changed this rule: it now applies ONLY to a legacy kind 'board' key
    // acting as an agent. A kind 'agent' token always carries the admin
    // scopes (AGENT_TOKEN_SCOPES) — the agent's role decides, not the token.
    if (
      k.kind === 'board' &&
      k.actsAs.kind === 'agent' &&
      k.scopes.some((s) => (ADMIN_SCOPES as readonly string[]).includes(s))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'A board token acting as an agent cannot carry admin scopes',
      });
    if (k.kind !== 'agent' && k.defaultBoardId !== undefined && k.defaultBoardId !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['defaultBoardId'],
        message: 'Only an agent token has a default board',
      });
    if (k.kind === 'agent') {
      // §AA1: who the agent is, and nothing else.
      if (k.actsAs.kind !== 'agent')
        ctx.addIssue({
          code: 'custom',
          path: ['actsAs'],
          message: 'An agent token acts as an agent',
        });
      if (k.boardId !== null)
        ctx.addIssue({
          code: 'custom',
          path: ['boardId'],
          message: 'An agent token has no board of its own',
        });
      if (!isAgentTokenScopes(k.scopes))
        ctx.addIssue({
          code: 'custom',
          path: ['scopes'],
          message: 'An agent token carries exactly AGENT_TOKEN_SCOPES',
        });
    } else if (k.kind === 'account') {
      // "Virtual me": no board of its own, and always the person — an agent
      // lives on ONE board, so an account-wide agent token is a contradiction.
      if (k.boardId !== null)
        ctx.addIssue({
          code: 'custom',
          path: ['boardId'],
          message: 'An account token has no board',
        });
      if (k.actsAs.kind !== 'user')
        ctx.addIssue({
          code: 'custom',
          path: ['actsAs'],
          message: 'An account token always acts as you, never as an agent',
        });
    } else {
      if (k.boardId === null)
        ctx.addIssue({
          code: 'custom',
          path: ['boardId'],
          message: 'A board token names its board',
        });
      if (k.scopes.some(isAccountScope))
        ctx.addIssue({
          code: 'custom',
          path: ['scopes'],
          message: 'Account-level scopes need an account token',
        });
    }
  });
export type ApiKey = z.infer<typeof ApiKeySchema>;
/** A stored row's kind, tolerating phase-2 rows that predate the field. */
export const apiKeyKind = (k: Pick<Partial<ApiKey>, 'kind'>): ApiKeyKind =>
  k.kind === 'account' ? 'account' : k.kind === 'agent' ? 'agent' : 'board';
export const API_KEY_PREFIX = 'tm_live_';
export const DEFAULT_API_KEY_LIMITS = { perMin: 60, perDay: 10_000 } as const;
/** The token form's Expires choices (null = never). */
export const API_KEY_EXPIRY_DAYS = [null, 30, 90, 365] as const;
/**
 * §R1: creating an account token is deliberate — the expiry defaults to 90
 * days, and 'never' is shown in red rather than removed.
 */
export const ACCOUNT_KEY_DEFAULT_EXPIRY_DAYS = 90;
/** Chars of the full key kept as `prefix` (API_KEY_PREFIX + 4). */
export const API_KEY_SHOWN_PREFIX_LEN = API_KEY_PREFIX.length + 4;

/** Is this key usable at `now`? (not revoked, not expired) */
export const apiKeyActive = (k: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now: number): boolean =>
  k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now);

/** users/{uid}/oauthGrants/{grantId} — revoke via grantRevoke. */
export const OAuthGrantSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string(),
  /** Accepts phase-1 names on read; always the new vocabulary after parsing. */
  scopes: ScopeListInputSchema,
  /** The consent screen's 'only these boards'; null = every board the person is on. */
  boardIds: z.array(BoardIdSchema).nullable().optional(),
  createdAt: MillisSchema,
  lastUsedAt: MillisSchema,
});
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;
