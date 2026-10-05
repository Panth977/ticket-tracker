/**
 * MINTING AN API KEY — the key format, in one place.
 *
 * apiKeyCreate (the app) and scripts/migrate-agent-tokens.mjs (§AA6, through
 * agents/tokenMigration.ts) both mint through this module, so a token minted
 * by the migration is indistinguishable from one generated in the app: same
 * prefix, same alphabet and length, same hash. It is a module of its own —
 * not part of the command — so the script can import it without loading the
 * command registry.
 *
 *   key     'tm_live_' + 32 base62 characters; returned ONCE, never stored
 *   prefix  the first API_KEY_SHOWN_PREFIX_LEN characters — what lists show
 *   hash    sha256 of the key — what is stored, and what the middleware looks up
 */
import {
  AGENT_TOKEN_SCOPES,
  API_KEY_PREFIX,
  API_KEY_SHOWN_PREFIX_LEN,
  DEFAULT_API_KEY_LIMITS,
  type ApiKey,
} from '@tm/shared';
import { base62, sha256hex } from './crypto.js';

export function mintApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + base62(32);
  return { key, prefix: key.slice(0, API_KEY_SHOWN_PREFIX_LEN), hash: sha256hex(key) };
}

/**
 * The stored row of a §AA1 agent token: it acts as the agent, has no board
 * and carries exactly AGENT_TOKEN_SCOPES. `defaultBoardId` is only for a
 * token converted from a board token (§AA6) — a freshly minted one has none.
 */
export function agentKeyDoc(input: {
  name: string;
  agentId: string;
  prefix: string;
  hash: string;
  now: number;
  expiresAt?: number | null;
  defaultBoardId?: string | null;
}): ApiKey {
  return {
    name: input.name,
    kind: 'agent',
    boardId: null,
    ...(input.defaultBoardId ? { defaultBoardId: input.defaultBoardId } : {}),
    actsAs: { kind: 'agent', id: input.agentId },
    scopes: [...AGENT_TOKEN_SCOPES],
    prefix: input.prefix,
    hash: input.hash,
    limits: { ...DEFAULT_API_KEY_LIMITS },
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    revokedReason: null,
    createdAt: input.now,
  };
}
