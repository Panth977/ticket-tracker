/**
 * MOVING WHAT EXISTS (docs/plan/agents.html §AA6) — the core of
 * scripts/migrate-agent-tokens.mjs, kept here so it is typed, shares the
 * backend's own helpers (the key format, deriveAccess, the shared schema) and
 * can be tested against the emulators.
 *
 * Old tokens keep working the moment §AA ships: a kind 'board' key acting as
 * an agent is resolved as before (middleware/apiKey.ts). This makes the data
 * say what the new model means. FOUR THINGS, and nothing else:
 *
 *   (a) KEYS      every LIVE key (not revoked, not expired) acting as an agent
 *                 becomes kind 'agent': boardId null, defaultBoardId = its old
 *                 board, scopes = AGENT_TOKEN_SCOPES. SAME SECRET, SAME HASH —
 *                 nothing has to be re-issued, and what called /v1/tickets
 *                 without a board still lands on the old board (defaultBoardId).
 *   (b) BOARDS    boards.agentIds is backfilled from `access` (deriveAccess) —
 *                 without it an agent token finds no boards.
 *   (c) ARTIFACTS artifacts.agents values become the object form
 *                 ('editor' → { build: true, data: 'write' }).
 *   (d) ONE NEW TOKEN for an agent that has MORE THAN ONE live token. They all
 *                 keep working (they are identical now); the owner is issued
 *                 one new agent token — named '<agent name> (agent token)',
 *                 no default board — to move the agent's callers onto, after
 *                 which "Revoke older tokens" in the app finishes the job.
 *
 * IT REVOKES NOTHING, and it never reads or prints a hash or a secret: the
 * plan carries prefixes only, and a minted secret is handed to the caller's
 * `writeSecret` exactly once (the script writes it to a 0600 file).
 *
 * IDEMPOTENT. Each part plans only what is not already so, so a second run
 * plans nothing. (d) is "this agent has several live tokens and NONE that is
 * its own" — a token of its own being an agent token with no default board,
 * live or not, whether this migration minted it or the owner generated it in
 * the app. Once one exists the agent is never minted for again.
 */
import {
  AGENT_TOKEN_SCOPES,
  agentAccessOf,
  apiKeyKind,
  COLLECTIONS,
  isAgentId,
  isAgentTokenScopes,
  paths,
  type Agent,
  type ApiKey,
  type Artifact,
  type ArtifactAgentAccess,
  type Board,
} from '@tm/shared';
import { deriveAccess } from '../commands/boardShared.js';
import { agentKeyDoc, mintApiKey } from '../platform/apiKeyMint.js';
import { db } from '../runtime/firebase.js';

/** A stored key row as it may be found (older rows lack newer fields). */
type StoredKey = Partial<ApiKey>;

export interface KeyConversion {
  /** users/{ownerUid}/apiKeys/{keyId} */
  path: string;
  ownerUid: string;
  keyId: string;
  name: string;
  /** 'tm_live_3fa9' — what the Tokens list shows. Never the hash. */
  prefix: string;
  agentId: string;
  /** Its board before the conversion → defaultBoardId. */
  defaultBoardId: string | null;
}
export interface BoardBackfill {
  boardId: string;
  key: string;
  agentIds: string[];
}
export interface ArtifactRewrite {
  artifactId: string;
  name: string;
  /** The whole map, in the object form. */
  agents: Record<string, ArtifactAgentAccess>;
  /** Which agents' values change. */
  rewritten: string[];
}
export interface AgentMint {
  ownerUid: string;
  agentId: string;
  agentName: string;
  /** Its live tokens today — why it gets one of its own. */
  liveKeys: number;
  /** The new token's name: '<agent name> (agent token)'. */
  name: string;
}
export interface AgentTokenMigrationPlan {
  keys: KeyConversion[];
  boards: BoardBackfill[];
  artifacts: ArtifactRewrite[];
  mints: AgentMint[];
}

const isLive = (k: StoredKey, now: number): boolean =>
  (k.revokedAt === null || k.revokedAt === undefined) &&
  (k.expiresAt === null || k.expiresAt === undefined || k.expiresAt > now);

const sameList = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** The name of the token minted for an agent (an ApiKey name is at most 80 characters). */
export const mintedTokenName = (agentName: string): string => {
  const suffix = ' (agent token)';
  return `${agentName.trim().slice(0, 80 - suffix.length)}${suffix}`;
};

/** READ ONLY: what a run would change. Nothing here writes. */
export async function planAgentTokenMigration(now: number): Promise<AgentTokenMigrationPlan> {
  const fs = db();

  // (a) + (d): every key acting as an agent, found under each person (a
  // collection-scope equality on the automatic index — no collection-group
  // index to create first). listDocuments also finds a users/{uid} that holds
  // keys but has no profile document.
  const keys: KeyConversion[] = [];
  const byAgent = new Map<string, { ownerUid: string; live: number; hasOwn: boolean }>();
  for (const user of await fs.collection(COLLECTIONS.users).listDocuments()) {
    const snap = await fs
      .collection(paths.apiKeys(user.id))
      .where('actsAs.kind', '==', 'agent')
      .get();
    for (const d of snap.docs) {
      const k = d.data() as StoredKey;
      const agentId = k.actsAs?.id;
      if (!agentId || !isAgentId(agentId)) continue;
      const live = isLive(k, now);
      const kind = apiKeyKind(k);
      const group = byAgent.get(agentId) ?? { ownerUid: user.id, live: 0, hasOwn: false };
      if (live) group.live += 1;
      // "A token of its own": an agent token that was never a board token.
      if (kind === 'agent' && !k.defaultBoardId) group.hasOwn = true;
      byAgent.set(agentId, group);
      if (!live) continue; // a dead key is left exactly as it is
      // Already an agent token in every respect (converted earlier, or
      // generated in the app): nothing to do — this is what makes a rerun a no-op.
      const done = kind === 'agent' && k.boardId === null && isAgentTokenScopes(k.scopes ?? []);
      if (done) continue;
      keys.push({
        path: d.ref.path,
        ownerUid: user.id,
        keyId: d.id,
        name: String(k.name ?? ''),
        prefix: String(k.prefix ?? ''),
        agentId,
        // A half-converted row keeps the default it already has.
        defaultBoardId: k.boardId ?? k.defaultBoardId ?? null,
      });
    }
  }

  // (d) one new token for an agent with several live ones and none of its own.
  const mints: AgentMint[] = [];
  for (const [agentId, g] of byAgent) {
    if (g.live <= 1 || g.hasOwn) continue;
    const agent = (await fs.doc(paths.agent(agentId)).get()).data() as Agent | undefined;
    // A missing or archived agent's tokens answer 401 already: nothing to issue.
    if (!agent || agent.ownerUid !== g.ownerUid || agent.archivedAt !== null) continue;
    mints.push({
      ownerUid: g.ownerUid,
      agentId,
      agentName: agent.name,
      liveKeys: g.live,
      name: mintedTokenName(agent.name),
    });
  }

  // (b) boards.agentIds, derived from access exactly as the commands derive it.
  const boards: BoardBackfill[] = [];
  for (const d of (await fs.collection(COLLECTIONS.boards).get()).docs) {
    const b = d.data() as Board;
    const { agentIds } = deriveAccess(b.access ?? {});
    if (!sameList(b.agentIds, agentIds)) boards.push({ boardId: d.id, key: b.key, agentIds });
  }

  // (c) artifacts.agents → the object form.
  const artifacts: ArtifactRewrite[] = [];
  for (const d of (await fs.collection(COLLECTIONS.artifacts).get()).docs) {
    const a = d.data() as Artifact;
    const rewritten = Object.entries(a.agents ?? {})
      .filter(([, v]) => typeof v !== 'object' || v === null)
      .map(([id]) => id);
    if (!rewritten.length) continue;
    artifacts.push({
      artifactId: d.id,
      name: a.name,
      agents: Object.fromEntries(
        Object.entries(a.agents ?? {}).map(([id, v]) => [id, agentAccessOf(v)]),
      ),
      rewritten,
    });
  }

  const byPath = (x: { path: string }, y: { path: string }) => x.path.localeCompare(y.path);
  return {
    keys: keys.sort(byPath),
    boards: boards.sort((x, y) => x.boardId.localeCompare(y.boardId)),
    artifacts: artifacts.sort((x, y) => x.artifactId.localeCompare(y.artifactId)),
    mints: mints.sort((x, y) => x.agentId.localeCompare(y.agentId)),
  };
}

export interface MintedToken {
  ownerUid: string;
  agentId: string;
  keyId: string;
  name: string;
  prefix: string;
}

/**
 * WRITE the plan. `writeSecret(agentId, key)` is called once per minted token
 * with the clear secret, BEFORE its row is stored — if the secret cannot be
 * kept, the token is not created (a token nobody holds would only be one
 * more thing to revoke). The secret is never returned and never logged here.
 */
export async function applyAgentTokenMigration(
  plan: AgentTokenMigrationPlan,
  now: number,
  writeSecret: (agentId: string, key: string) => Promise<void> | void,
): Promise<{ keys: number; boards: number; artifacts: number; minted: MintedToken[] }> {
  const fs = db();
  const inBatches = async <T>(
    items: readonly T[],
    add: (b: FirebaseFirestore.WriteBatch, item: T) => void,
  ) => {
    for (let i = 0; i < items.length; i += 400) {
      const b = fs.batch();
      for (const item of items.slice(i, i + 400)) add(b, item);
      await b.commit();
    }
  };

  // BOARDS AND ARTIFACTS FIRST, KEYS LAST. A converted key finds its boards
  // through boards.agentIds; converting it before that field exists would
  // leave a moment where a running orchestrator's token reaches no board.
  await inBatches(plan.boards, (b, x) =>
    b.update(fs.doc(paths.board(x.boardId)), { agentIds: x.agentIds }),
  );
  await inBatches(plan.artifacts, (b, x) =>
    b.update(fs.doc(`${COLLECTIONS.artifacts}/${x.artifactId}`), { agents: x.agents }),
  );
  // Secret and hash are untouched: update() changes only the fields named.
  await inBatches(plan.keys, (b, k) =>
    b.update(fs.doc(k.path), {
      kind: 'agent',
      boardId: null,
      defaultBoardId: k.defaultBoardId,
      scopes: [...AGENT_TOKEN_SCOPES],
    }),
  );

  const minted: MintedToken[] = [];
  for (const m of plan.mints) {
    const { key, prefix, hash } = mintApiKey();
    await writeSecret(m.agentId, key);
    const ref = fs.collection(paths.apiKeys(m.ownerUid)).doc();
    await ref.create(agentKeyDoc({ name: m.name, agentId: m.agentId, prefix, hash, now }));
    minted.push({ ownerUid: m.ownerUid, agentId: m.agentId, keyId: ref.id, name: m.name, prefix });
  }
  return {
    keys: plan.keys.length,
    boards: plan.boards.length,
    artifacts: plan.artifacts.length,
    minted,
  };
}
