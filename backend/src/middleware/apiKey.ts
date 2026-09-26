/**
 * `apiKey` middleware core — API key v2 (docs/plan/agents.html §E).
 *
 * PHASE 10 (§R1) — TWO KINDS OF KEY, ONE RESOLVER:
 *   kind 'board'   (every phase-2 row): ONE board, acting as the owner or one
 *                  of their agents → boardIds: [boardId].
 *   kind 'account' ("virtual me"): NO board of its own, always the owner →
 *                  boardIds: null, which every downstream reader already
 *                  understands as "every board this actor is on". THE BOARD
 *                  SET IS NEVER STORED OR CACHED: readableBoards() asks
 *                  Firestore on each call and can() asks the board's own
 *                  access map, so losing access to a board takes effect on
 *                  the very next request.
 *
 *   'tm_live_…' → users/{ownerUid}/apiKeys where hash == sha256(key)
 *     → ctx {
 *         actor:    actsAs.kind === 'agent' ? agentId : ownerUid,   // who the change is AUTHORED by
 *         ownerUid, keyId, keyName,                                 // who is answerable; 'via token <name>'
 *         via:      'api' (REST) | 'mcp' (MCP door),
 *         scopes:   the key's scopes,
 *         boardIds: [key.boardId] | null,                           // one board, or the live set
 *       }
 *
 * A TOKEN IS ONLY AS GOOD AS WHAT STANDS BEHIND IT, checked on every request
 * (a handful of reads — cheaper than a revocation fan-out we could forget):
 *   - not revoked, not expired
 *   - BOARD tokens: the board still exists and the OWNER is still on it
 *   - agent tokens: the agent still exists, is still the owner's, is not
 *     archived and is still on the board
 *   - ACCOUNT tokens have no board to check here — there is nothing to go
 *     stale. Every board is authorised per request by can() against that
 *     board's live access map, which is 403 (a permission), not 401.
 * Any of those failing is a 401 ("this token no longer works"), never a 403:
 * the caller has to get a new token, not ask for a permission.
 *
 * What the token may DO is then scopes ∩ can() for the acting principal, per
 * request, in the commands — this file only establishes who and where.
 */
import {
  apiKeyKind,
  COLLECTIONS,
  errors,
  isAgentId,
  paths,
  rateBuckets,
  type Agent,
  type ApiKey,
  type ApiKeyKind,
  type Board,
  type Via,
} from '@tm/shared';
import { roleOf } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import { assertAllowedOwner } from '../platform/allow.js';
import { sha256hex } from '../platform/crypto.js';
import { rateLimit } from '../platform/rateLimit.js';
import { makeCtx, type ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';

/** lastUsedAt is refreshed at most once a minute (a write per call would be a hot document). */
export const LAST_USED_EVERY_MS = 60_000;

/** What the doors know about the key beyond the ctx (GET /v1/me, MCP whoami). */
export interface ApiKeyInfo {
  keyId: string;
  ownerUid: string;
  name: string;
  prefix: string;
  /** §R1: 'board' or 'account'. */
  kind: ApiKeyKind;
  /** The token's board; null for an account token. */
  boardId: string | null;
  actsAs: ApiKey['actsAs'];
  expiresAt: number | null;
}

/** A stored key row, tolerant of phase-1 rows (no boardId / actsAs). */
type StoredKey = Partial<ApiKey> &
  Pick<ApiKey, 'name' | 'scopes' | 'revokedAt' | 'expiresAt' | 'lastUsedAt'>;

/**
 * THE KEY LOOKUP, MADE CHEAP (§W).
 *
 * Every call used to cost an apiKeys COLLECTION-GROUP query, and only once it
 * came back could the board and the agent behind it be read — three round
 * trips, in two waves, before any work. On a platform that bills CPU for the
 * whole request, I/O wait included, an orchestrator polling twice a minute
 * paid for that ~40,000 times in three days.
 *
 * NOTHING ABOUT THE ANSWER IS CACHED. What an instance remembers is only
 * WHERE to look: which user's apiKeys row this token is, and which board and
 * agent stand behind it. With those paths in hand the key, the board and the
 * agent are read in ONE getAll — one round trip — and every check below runs
 * exactly as it did before, on this request's data. Revoking a token, taking
 * its agent off the board or removing its owner still bites on the very next
 * call.
 *
 * If anything has moved (the row is gone, the hash no longer matches, the key
 * now points at another board), the memory is dropped and the full lookup
 * runs again.
 */
interface KeyPlace {
  ownerUid: string;
  keyId: string;
  boardId: string | null;
  agentId: string | null;
}
const keyPlaces = new Map<string, KeyPlace>();
/** Bounded: an instance sees a handful of tokens, but a scanner must not grow this without limit. */
const KEY_CACHE_MAX = 200;

/** Tests. */
export function forgetCachedKeys(): void {
  keyPlaces.clear();
}

/**
 * Validate the key and everything behind it. Throws unauthenticated (→ 401)
 * or rate_limited (→ 429). Pure of HTTP so REST, MCP and tests share it.
 */
export async function resolveApiKey(
  token: string,
  now: number,
): Promise<{ info: ApiKeyInfo; key: StoredKey }> {
  const hash = sha256hex(token);
  const place = keyPlaces.get(token);
  /** Read in the same round trip as the key when we know where they are. */
  let prefetched: Map<string, FirebaseFirestore.DocumentSnapshot> | null = null;
  let doc: FirebaseFirestore.DocumentSnapshot | undefined;
  if (place) {
    const refs = [
      db().doc(paths.apiKey(place.ownerUid, place.keyId)),
      ...(place.boardId ? [db().doc(paths.board(place.boardId))] : []),
      ...(place.agentId ? [db().doc(paths.agent(place.agentId))] : []),
    ];
    const snaps = await db().getAll(...refs);
    prefetched = new Map(snaps.map((d) => [d.ref.path, d]));
    const first = snaps[0]!;
    if (first.exists && first.get('hash') === hash) doc = first;
    else keyPlaces.delete(token); // moved, replaced or gone: look it up properly
  }
  if (!doc) {
    prefetched = null;
    doc = (await db().collectionGroup(COLLECTIONS.apiKeys).where('hash', '==', hash).limit(1).get())
      .docs[0];
  }
  if (!doc) throw errors.unauthenticated('Unknown API key');
  const key = doc.data() as StoredKey;
  if (key.revokedAt !== null && key.revokedAt !== undefined)
    throw errors.unauthenticated('This API key was revoked');
  if (key.expiresAt !== null && key.expiresAt !== undefined && key.expiresAt <= now)
    throw errors.unauthenticated('This API key has expired');
  const kind = apiKeyKind(key);
  if (!key.actsAs)
    throw errors.unauthenticated(
      'This API key predates board-scoped tokens — create a new one in Account › Tokens',
    );
  const ownerUid = doc.ref.parent.parent!.id;

  // §X — THE ALLOW LIST. A token is only as good as the person behind it: the
  // owner must still be allowed to use this app at all. Checked here, before
  // the board and the agent, so a removed account's orchestrators stop on
  // their next call without anyone hunting down their tokens.
  await assertAllowedOwner(ownerUid);

  if (kind === 'account') {
    // §R1: an account token always acts as the person. A stored row claiming
    // otherwise is malformed, not a permission problem — refuse the token.
    if (key.actsAs.kind !== 'user')
      throw errors.unauthenticated(
        'This API key is account-wide but acts as an agent — create a new one',
      );
    // Deliberately NO board lookup: there is no board to go stale, and
    // reading the whole board set here would be the cache §R1 forbids.
  } else {
    if (!key.boardId)
      throw errors.unauthenticated(
        'This API key predates board-scoped tokens — create a new one in Account › Tokens',
      );
    const agentId = key.actsAs.kind === 'agent' ? key.actsAs.id : null;
    const boardPath = paths.board(key.boardId);
    const agentPath = agentId ? paths.agent(agentId) : null;
    const [boardSnap, agentSnap] = await Promise.all([
      prefetched?.get(boardPath) ?? db().doc(boardPath).get(),
      agentPath ? (prefetched?.get(agentPath) ?? db().doc(agentPath).get()) : Promise.resolve(null),
    ]);
    const board = boardSnap.exists ? (boardSnap.data() as Board) : undefined;
    if (!board) throw errors.unauthenticated("This API key's board no longer exists");
    if (!roleOf(board, ownerUid))
      throw errors.unauthenticated("This API key's owner is no longer on its board");
    if (agentId) {
      const agent = agentSnap?.exists ? (agentSnap.data() as Agent) : undefined;
      if (!agent || agent.ownerUid !== ownerUid)
        throw errors.unauthenticated("This API key's agent no longer exists");
      if (agent.archivedAt !== null)
        throw errors.unauthenticated("This API key's agent is archived");
      if (!roleOf(board, agentId))
        throw errors.unauthenticated("This API key's agent is no longer on its board");
    }
  }

  return finish(doc.id, ownerUid, key, kind, now, token);
}

/** Count the call, remember where the key lives, and shape the answer. */
async function finish(
  keyId: string,
  ownerUid: string,
  key: StoredKey,
  kind: ApiKeyKind,
  now: number,
  token: string,
): Promise<{ info: ApiKeyInfo; key: StoredKey }> {
  const actsAs = key.actsAs;
  if (!actsAs)
    throw errors.unauthenticated(
      'This API key predates board-scoped tokens — create a new one in Account › Tokens',
    );
  await countCall(ownerUid, keyId, key, now);
  if (keyPlaces.size >= KEY_CACHE_MAX) keyPlaces.clear();
  keyPlaces.set(token, {
    ownerUid,
    keyId,
    boardId: kind === 'account' ? null : (key.boardId ?? null),
    agentId: actsAs.kind === 'agent' ? actsAs.id : null,
  });
  const resolved = {
    key,
    info: {
      keyId,
      ownerUid,
      name: key.name,
      prefix: key.prefix ?? '',
      kind,
      boardId: kind === 'account' ? null : key.boardId!,
      actsAs,
      expiresAt: key.expiresAt ?? null,
    },
  };
  return resolved;
}

/** Rate limit and lastUsedAt — the two things that must happen on EVERY call, cached or not. */
async function countCall(
  ownerUid: string,
  keyId: string,
  key: StoredKey,
  now: number,
): Promise<void> {
  const limits = key.limits ?? { perMin: 60, perDay: 10_000 };
  await rateLimit(rateBuckets.apiKey(keyId), limits, now);
  if (
    key.lastUsedAt === null ||
    key.lastUsedAt === undefined ||
    now - key.lastUsedAt > LAST_USED_EVERY_MS
  ) {
    // The cached copy carries the new stamp too, so the write happens once a minute, not once a request.
    key.lastUsedAt = now;
    await db()
      .doc(paths.apiKey(ownerUid, keyId))
      .update({ lastUsedAt: now })
      .catch(() => {});
  }
}

/** Resolve a 'tm_live_…' key into the request ctx (see the header comment). */
export async function apiKeyCtx(
  token: string,
  via: Extract<Via, 'api' | 'mcp'>,
  requestId?: string,
): Promise<ServerCtx & { apiKey: ApiKeyInfo }> {
  const now = ports().clock.now();
  const { info, key } = await resolveApiKey(token, now);
  const actor = info.actsAs.kind === 'agent' ? info.actsAs.id : info.ownerUid;
  if (info.actsAs.kind === 'agent' && !isAgentId(actor))
    throw errors.unauthenticated('Malformed API key');
  const ctx = makeCtx({
    actor,
    ownerUid: info.ownerUid,
    keyId: info.keyId,
    keyName: info.name,
    via,
    scopes: [...key.scopes],
    // null = "every board this actor is on", resolved fresh on every read
    // (platform/resolve.ts readableBoards) — never a stored list.
    boardIds: info.kind === 'account' ? null : [info.boardId!],
    now,
    ...(requestId ? { requestId } : {}),
  });
  return { ...ctx, apiKey: info };
}
