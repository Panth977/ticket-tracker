/**
 * Tokens (apiKeyCreate v2, agents.html §E, and §R1) — the create form's
 * choices, the list's helpers, and the "shown once" snippets.
 *
 * THREE KINDS, one form:
 *   board · me      one board, acting as me
 *   board · agent   one board, acting as one of my agents on it
 *   account         §R1 "virtual me": no board, acting as me on EVERY board I
 *                   am on, as that stands at each call
 */
import {
  ACCOUNT_KEY_DEFAULT_EXPIRY_DAYS,
  ACCOUNT_SCOPES,
  ACCOUNT_TOKEN_PRESETS,
  ADMIN_SCOPES,
  API_KEY_EXPIRY_DAYS,
  BOARD_TOKEN_PRESETS,
  isAccountScope,
  presetOf,
  SCOPE_LABELS,
  SCOPE_PRESET_LABELS,
  SCOPES,
  TOKEN_SCOPES,
  type ApiKey,
  type ApiKeyKind,
  type Scope,
  type ScopePreset,
} from '@tm/shared';

export const EXPIRY_OPTIONS = API_KEY_EXPIRY_DAYS.map((d) => ({
  value: d === null ? 'never' : String(d),
  label: d === null ? 'Never' : d === 365 ? '1 year' : `${d} days`,
})) as { value: ExpiryChoice; label: string }[];
export type ExpiryChoice = 'never' | '30' | '90' | '365';

export function expiresInDays(choice: ExpiryChoice): number | undefined {
  return choice === 'never' ? undefined : Number(choice);
}

/**
 * §R1 — "an expiry that defaults to 90 days (never is possible, and says so
 * in red)". The default for a board token is unchanged.
 */
export const ACCOUNT_DEFAULT_EXPIRY: ExpiryChoice = String(
  ACCOUNT_KEY_DEFAULT_EXPIRY_DAYS,
) as ExpiryChoice;
/** Should 'Never' be shown as a warning? Only for an account token. */
export const expiryIsRisky = (kind: ApiKeyKind, choice: ExpiryChoice): boolean =>
  kind === 'account' && choice === 'never';

export type KeyState = 'active' | 'expired' | 'revoked';

export function keyState(k: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()): KeyState {
  if (k.revokedAt != null) return 'revoked';
  if (k.expiresAt != null && k.expiresAt <= now) return 'expired';
  return 'active';
}

/** Active first (newest first), then expired, then revoked. */
export function sortKeys<T extends Pick<ApiKey, 'revokedAt' | 'expiresAt' | 'createdAt'>>(
  keys: T[],
  now = Date.now(),
): T[] {
  const rank: Record<KeyState, number> = { active: 0, expired: 1, revoked: 2 };
  return [...keys].sort(
    (a, b) => rank[keyState(a, now)] - rank[keyState(b, now)] || b.createdAt - a.createdAt,
  );
}

/** Why a revoked token stopped working, for the list. */
export function revokedReasonLabel(reason: ApiKey['revokedReason']): string {
  switch (reason) {
    case 'agentArchived':
      return 'Revoked · agent archived';
    case 'agentRemoved':
      return 'Revoked · agent left the board';
    case 'ownerLeft':
      return 'Revoked · you left the board';
    default:
      return 'Revoked';
  }
}

/** 'Worker' / 'Full account' / '5 permissions' (+ ' + admin'). */
export function scopesSummary(scopes: readonly Scope[]): string {
  // 'Full account' is a preset in its own right; name it rather than
  // describing it as 'Everything + 4 more'.
  const whole = presetOf(scopes);
  if (whole) return SCOPE_PRESET_LABELS[whole];
  const admin = scopes.filter((s) => (ADMIN_SCOPES as readonly string[]).includes(s));
  const account = scopes.filter(isAccountScope);
  const plain = scopes.filter(
    (s) => !(ADMIN_SCOPES as readonly string[]).includes(s) && !isAccountScope(s),
  );
  const preset = presetOf(plain);
  const base = preset
    ? SCOPE_PRESET_LABELS[preset]
    : `${plain.length} permission${plain.length === 1 ? '' : 's'}`;
  const extra = [...(admin.length ? ['admin'] : []), ...(account.length ? ['account'] : [])];
  return extra.length ? `${base} + ${extra.join(' + ')}` : base;
}

/** 'Account token' / 'Board token' — the badge on a list row (§R1). */
export const tokenKindLabel = (kind: ApiKeyKind): string =>
  kind === 'account' ? 'Account token' : 'Board token';

/** Tooltip: one scope per line, with its label. */
export function scopesTooltip(scopes: readonly Scope[]): string {
  return SCOPES.filter((s) => scopes.includes(s))
    .map((s) => `${s} — ${SCOPE_LABELS[s]}`)
    .join('\n');
}

const preset = (id: ScopePreset) => ({ id, label: SCOPE_PRESET_LABELS[id] });
/** @deprecated use presetsFor(kind) — kept so older callers keep compiling. */
export const PRESETS = BOARD_TOKEN_PRESETS.map(preset);
/**
 * Which presets a kind offers: 'Full account' belongs to an account token and
 * 'Everything' (every board checkbox, one board) to a board one.
 */
export const presetsFor = (kind: ApiKeyKind): { id: ScopePreset; label: string }[] =>
  (kind === 'account' ? ACCOUNT_TOKEN_PRESETS : BOARD_TOKEN_PRESETS).map(preset);

/** The checkboxes, in display order, grouped for the form. */
export const SCOPE_SECTIONS: { title: string; scopes: Scope[] }[] = [
  { title: 'Board', scopes: ['board:read', 'members:read'] },
  {
    title: 'Tickets',
    scopes: [
      'tickets:read',
      'tickets:create',
      'tickets:update',
      'tickets:move',
      'tickets:assign',
      'tickets:state',
    ],
  },
  {
    title: 'Threads & files',
    scopes: ['comments:read', 'comments:write', 'files:read', 'files:write'],
  },
  // Phase 3 (§L4): what an orchestrator needs to work in the open — ask
  // questions, publish its plan, and say it is alive.
  { title: 'Agent work', scopes: ['questions:write', 'tasklists:write', 'status:write'] },
  { title: 'Events', scopes: ['events:read'] },
];
// Every token scope appears exactly once.
if (SCOPE_SECTIONS.flatMap((s) => s.scopes).length !== TOKEN_SCOPES.length)
  throw new Error('SCOPE_SECTIONS out of date');

/**
 * §R1 — the account-level checkboxes, offered ONLY for an account token.
 * They are not about one board: they are the few things "virtual me" does
 * that no board checkbox covers. They still only narrow — boards:admin
 * reaches settings on the boards where you are an admin today, and nowhere
 * else.
 */
export const ACCOUNT_SCOPE_SECTION: { title: string; scopes: Scope[] } = {
  title: 'Your account',
  scopes: [...ACCOUNT_SCOPES],
};

/** What an account token can NEVER do, in the words the form shows (§R1). */
export const ACCOUNT_TOKEN_NEVER = [
  'create or revoke tokens',
  'grant or revoke app access',
  'change your sign-in or security settings',
  'delete or export your account',
] as const;

/** Toggle one scope, keeping SCOPES order. */
export function toggleScope(scopes: readonly Scope[], s: Scope, on: boolean): Scope[] {
  const set = new Set(scopes);
  if (on) set.add(s);
  else set.delete(s);
  return SCOPES.filter((x) => set.has(x));
}

export interface TokenDraft {
  name: string;
  /** §R1: 'board' (one board) or 'account' (every board I am on). */
  kind: ApiKeyKind;
  /** kind 'board' only. */
  boardId: string | null;
  actsAs: 'me' | 'agent';
  agentId: string | null;
  scopes: Scope[];
  expiry: ExpiryChoice;
}

/** The three choices the form offers, as one value. */
export type TokenChoice = 'me' | 'agent' | 'account';
export const choiceOf = (d: Pick<TokenDraft, 'kind' | 'actsAs'>): TokenChoice =>
  d.kind === 'account' ? 'account' : d.actsAs;

/**
 * Switch the form between the three choices, keeping everything that still
 * makes sense. Going to 'account' drops the board, the agent and the admin
 * scopes (which the account scopes replace); coming back drops the account
 * scopes, which a board token may not carry.
 */
export function withChoice(d: TokenDraft, choice: TokenChoice): TokenDraft {
  if (choice === 'account')
    return {
      ...d,
      kind: 'account',
      boardId: null,
      actsAs: 'me',
      agentId: null,
      scopes: d.scopes.filter((s) => !(ADMIN_SCOPES as readonly string[]).includes(s)),
      // Deliberate, not incidental: an account token starts with an expiry.
      expiry: d.expiry === 'never' ? ACCOUNT_DEFAULT_EXPIRY : d.expiry,
    };
  return {
    ...d,
    kind: 'board',
    actsAs: choice,
    scopes: d.scopes.filter((s) => !isAccountScope(s)),
  };
}

/** Problems with a token draft, by field (empty = can create). */
export function tokenDraftErrors(
  d: TokenDraft,
): Partial<Record<'name' | 'boardId' | 'agentId' | 'scopes', string>> {
  const e: Partial<Record<'name' | 'boardId' | 'agentId' | 'scopes', string>> = {};
  const account = d.kind === 'account';
  if (!d.name.trim()) e.name = 'Name it after what will use it, e.g. “orch-eng-builder”.';
  else if (d.name.trim().length > 80) e.name = 'At most 80 characters.';
  // An account token has no board on purpose — asking for one would be wrong.
  if (!account && !d.boardId) e.boardId = 'Pick the board this token works on.';
  if (!account && d.actsAs === 'agent' && !d.agentId)
    e.agentId = 'Pick one of your agents on this board.';
  if (!d.scopes.length) e.scopes = 'Pick at least one permission.';
  else if (
    d.actsAs === 'agent' &&
    d.scopes.some((s) => (ADMIN_SCOPES as readonly string[]).includes(s))
  )
    e.scopes = 'An agent token cannot carry admin permissions.';
  else if (!account && d.scopes.some(isAccountScope))
    e.scopes = 'Account permissions need an account token.';
  return e;
}

/** The apiKeyCreate input for a valid draft. */
export function tokenRequest(d: TokenDraft) {
  const days = expiresInDays(d.expiry);
  const account = d.kind === 'account';
  const scopes = account
    ? d.scopes
    : d.scopes.filter(
        (s) =>
          !isAccountScope(s) &&
          !(d.actsAs === 'agent' && (ADMIN_SCOPES as readonly string[]).includes(s)),
      );
  return {
    name: d.name.trim(),
    kind: d.kind,
    // The command takes boardId: null for an account token.
    boardId: account ? null : d.boardId!,
    actsAs:
      !account && d.actsAs === 'agent'
        ? { kind: 'agent' as const, id: d.agentId! }
        : { kind: 'user' as const },
    scopes,
    ...(days ? { expiresInDays: days } : {}),
  };
}

/** Where REST (/v1) and MCP (/mcp) live: PUBLIC_API_BASE, else this origin (hosting rewrites both to the api function). */
export function apiBase(env: string | undefined, origin: string): string {
  return (env || origin).replace(/\/+$/, '');
}
