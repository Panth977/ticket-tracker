/**
 * Platform vocabulary (platform/db.json `types`): scopes, webhook events and
 * the webhook envelope.
 */
import { z } from 'zod';
import { ViaSchema } from './notify.js';

/**
 * ONE VOCABULARY FOR API KEYS, OAUTH AND MCP (phase 2, docs/plan/agents.html §E).
 * A scope NARROWS what the acting principal's board role allows and never
 * widens it: what a token may do is its scopes ∩ can().
 *
 * The first 16 are the token form's checkboxes, in display order. The last two
 * are ADMIN scopes a token acting as a PERSON may carry (board settings,
 * webhooks); an agent is never admin, so agent tokens never carry them.
 */
export const TOKEN_SCOPES = [
  'board:read',
  'members:read',
  'tickets:read',
  'tickets:create',
  /** title, description, fields, dates, tags, links */
  'tickets:update',
  'tickets:move',
  'tickets:assign',
  /** archive / restore */
  'tickets:state',
  'comments:read',
  'comments:write',
  'files:read',
  'files:write',
  /** Phase 3 (§L4): ask and cancel questions in a thread. */
  'questions:write',
  /** Phase 3: publish and tick off task lists on a ticket. */
  'tasklists:write',
  /** Phase 3: send heartbeats (POST /v1/heartbeat, MCP heartbeat). */
  'status:write',
  'events:read',
] as const;
export const ADMIN_SCOPES = ['board:admin', 'webhooks:manage'] as const;
/**
 * PHASE 10 (§R1) — ACCOUNT-LEVEL scopes, only ever carried by an ACCOUNT
 * token (ApiKey kind 'account'). They are not about one board: they are the
 * few things "virtual me" does that no board-scoped checkbox covers.
 *
 * They still only NARROW: boards:admin reaches board settings ONLY on boards
 * where the owner is an admin today, exactly as board:admin does for a board
 * token. Nothing here lets a token mint a token (TOKEN_DENIED_COMMANDS).
 */
export const ACCOUNT_SCOPES = [
  /** Create a new board (the token becomes its admin, because you do). */
  'boards:create',
  /** Board settings and people, on boards where you are an admin. */
  'boards:admin',
  /** Create and edit your agent profiles, and put them on boards. */
  'agents:write',
  /** Invite people to boards you administer, and revoke invites. */
  'invites:write',
] as const;
export const SCOPES = [...TOKEN_SCOPES, ...ADMIN_SCOPES, ...ACCOUNT_SCOPES] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type AdminScope = (typeof ADMIN_SCOPES)[number];
export type AccountScope = (typeof ACCOUNT_SCOPES)[number];
export const isAccountScope = (s: string): s is AccountScope =>
  (ACCOUNT_SCOPES as readonly string[]).includes(s);

/** Human labels for the token form and the OAuth consent screen. */
export const SCOPE_LABELS: Record<Scope, string> = {
  'board:read': 'Read the board (stages, fields, tags)',
  'members:read': 'See the people and agents on the board',
  'tickets:read': 'Read tickets',
  'tickets:create': 'Create tickets',
  'tickets:update': 'Edit tickets (title, description, fields, dates, tags, links)',
  'tickets:move': 'Move tickets between stages',
  'tickets:assign': 'Assign and unassign tickets',
  'tickets:state': 'Archive and restore tickets',
  'comments:read': 'Read ticket threads',
  'comments:write': 'Post, edit, pin and react in threads',
  'files:read': 'Read and download files',
  'files:write': 'Upload files',
  'questions:write': 'Ask questions in a thread and cancel them',
  'tasklists:write': 'Publish and update task lists on a ticket',
  'status:write': 'Send heartbeats (what the agent is doing now)',
  'events:read': 'Read and acknowledge the event inbox',
  'board:admin': 'Change board settings (admins only)',
  'webhooks:manage': 'Manage webhooks (admins only)',
  // Account tokens only (§R1).
  'boards:create': 'Create new boards',
  'boards:admin': 'Change settings and people on boards where you are an admin',
  'agents:write': 'Create and edit your agents, and put them on boards',
  'invites:write': 'Invite people to boards you administer',
};

const READ_ONLY: readonly Scope[] = [
  'board:read',
  'members:read',
  'tickets:read',
  'comments:read',
  'files:read',
  'events:read',
];
/** The token form's presets (§E). 'everything' = every checkbox (no admin scopes). */
export const SCOPE_PRESETS = {
  readOnly: READ_ONLY,
  worker: [
    ...READ_ONLY,
    'comments:write',
    'files:write',
    'tickets:move',
    'tickets:update',
    // phase 3 (§L3, §L4): a worker asks, plans and says what it is doing.
    'questions:write',
    'tasklists:write',
    'status:write',
  ],
  everything: [...TOKEN_SCOPES],
  /** §R1: every board checkbox, on every board, plus the account-level ones. */
  fullAccount: [...TOKEN_SCOPES, ...ACCOUNT_SCOPES],
} as const satisfies Record<string, readonly Scope[]>;
export type ScopePreset = keyof typeof SCOPE_PRESETS;
export const SCOPE_PRESET_LABELS: Record<ScopePreset, string> = {
  readOnly: 'Read only',
  worker: 'Worker',
  everything: 'Everything',
  fullAccount: 'Full account',
};
/** Which presets each token kind offers (§E board tokens, §R1 account tokens). */
export const BOARD_TOKEN_PRESETS = [
  'readOnly',
  'worker',
  'everything',
] as const satisfies readonly ScopePreset[];
export const ACCOUNT_TOKEN_PRESETS = [
  'readOnly',
  'worker',
  'fullAccount',
] as const satisfies readonly ScopePreset[];

/** Which preset exactly matches a scope list, or null (custom). */
export function presetOf(scopes: readonly Scope[]): ScopePreset | null {
  const have = new Set(scopes);
  for (const [name, list] of Object.entries(SCOPE_PRESETS) as [ScopePreset, readonly Scope[]][]) {
    if (list.length === have.size && list.every((s) => have.has(s))) return name;
  }
  return null;
}

/**
 * PHASE-1 SCOPES — still accepted as INPUT (stored OAuth grants/tokens, the
 * `scope` parameter of older MCP clients) and expanded to the new vocabulary.
 * They are never written back.
 */
export const LEGACY_SCOPES = [
  'boards:read',
  'boards:write',
  'tickets:read',
  'tickets:write',
  'comments:read',
  'comments:write',
  'members:read',
  'webhooks:manage',
] as const;
export type LegacyScope = (typeof LEGACY_SCOPES)[number];
export const LEGACY_SCOPE_MAP: Record<LegacyScope, readonly Scope[]> = {
  'boards:read': ['board:read'],
  'boards:write': ['board:read', 'board:admin'],
  'tickets:read': ['board:read', 'tickets:read', 'files:read'],
  'tickets:write': [
    'board:read',
    'tickets:read',
    'tickets:create',
    'tickets:update',
    'tickets:move',
    'tickets:assign',
    'tickets:state',
    'files:read',
    'files:write',
  ],
  'comments:read': ['comments:read', 'files:read'],
  'comments:write': ['comments:read', 'comments:write', 'files:read', 'files:write'],
  'members:read': ['members:read'],
  'webhooks:manage': ['webhooks:manage'],
};

export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);
export const isLegacyScope = (s: string): s is LegacyScope =>
  (LEGACY_SCOPES as readonly string[]).includes(s);

/**
 * Any mix of new and phase-1 scope names → the new vocabulary, deduplicated,
 * in SCOPES order. Unknown names are returned in `unknown` (callers answer
 * invalid_scope / 400). Names spelled the same in both vocabularies
 * ('tickets:read', 'comments:read', …) are read with their PHASE-1 meaning, so
 * an old grant keeps what it had (tickets:read also reads files). Use this only
 * for phase-1 sources (OAuth); API keys v2 are parsed with ScopeSchema.
 */
export function normalizeScopes(input: readonly string[]): { scopes: Scope[]; unknown: string[] } {
  const out = new Set<Scope>();
  const unknown: string[] = [];
  for (const raw of input) {
    const s = raw.trim();
    if (!s) continue;
    if (isLegacyScope(s)) for (const x of LEGACY_SCOPE_MAP[s]) out.add(x);
    else if (isScope(s)) out.add(s);
    else unknown.push(s);
  }
  return { scopes: SCOPES.filter((s) => out.has(s)), unknown };
}

/**
 * A stored or requested scope list: accepts new AND phase-1 names, always
 * yields the new vocabulary. Use for OAuth grants / tokens; API keys v2 store
 * the new names only (ScopeSchema).
 */
export const ScopeListInputSchema = z.array(z.string()).transform((list, ctx) => {
  const { scopes, unknown } = normalizeScopes(list);
  if (unknown.length)
    ctx.addIssue({ code: 'custom', message: `Unknown scope(s): ${unknown.join(', ')}` });
  return scopes;
});

/** Does this scope list include `need`? Absent list (a full app session) = yes. */
export const hasScope = (scopes: readonly Scope[] | undefined | null, need: Scope): boolean =>
  !scopes || scopes.includes(need);

/** ANY of `needs` present? Absent list = yes; empty `needs` = no (nothing grants it). */
export const hasAnyScope = (
  scopes: readonly Scope[] | undefined | null,
  needs: readonly Scope[],
): boolean => !scopes || needs.some((n) => scopes.includes(n));

export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.moved',
  'ticket.state',
  'ticket.deleted',
  'message.created',
  'message.pinned',
  'board.updated',
  'member.joined',
] as const;
export const WebhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/**
 * What a webhook receiver gets. `data` is the PUBLIC shape (PublicTicket,
 * PublicMessage …), never the raw doc. Receivers dedupe on `id`.
 *
 * Headers: X-TM-Event, X-TM-Delivery,
 *          X-TM-Signature: t=<unix>,v1=hex(HMAC_SHA256(secret, `${t}.${body}`))
 */
export function envelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    /** 'evt_…' */
    id: z.string().regex(/^evt_/),
    /** 'ping' is sent once when a webhook is saved; it is not subscribable. */
    type: z.union([WebhookEventSchema, z.literal('ping')]),
    /** ISO 8601 */
    createdAt: z.string().datetime({ offset: true }),
    boardId: z.string(),
    actor: z.object({
      id: z.string(),
      name: z.string(),
      via: ViaSchema,
      /** Phase 2: 'user' | 'agent' (absent on phase-1 deliveries = user). */
      kind: z.enum(['user', 'agent']).optional(),
      /** Phase 2: the token's name when a token made the change. */
      via_token: z.string().nullable().optional(),
    }),
    data,
  });
}
export const EnvelopeSchema = envelopeSchema(z.unknown());
export interface Envelope<T = unknown> {
  id: string;
  type: WebhookEvent | 'ping';
  createdAt: string;
  boardId: string;
  actor: {
    id: string;
    name: string;
    via: z.infer<typeof ViaSchema>;
    kind?: 'user' | 'agent';
    via_token?: string | null;
  };
  data: T;
}

export const WEBHOOK_HEADERS = {
  event: 'X-TM-Event',
  delivery: 'X-TM-Delivery',
  signature: 'X-TM-Signature',
} as const;
