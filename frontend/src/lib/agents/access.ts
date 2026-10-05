/**
 * §AA — ONE TOKEN PER AGENT; WHAT IT MAY DO LIVES WHERE IT WORKS
 * (docs/plan/agents.html §AA1–§AA5). The pure half of the agent page's two
 * cards, so the screens and the tests share one answer:
 *
 *   Token   which of my apiKeys are "this agent's token(s)", which one is THE
 *           token and which are the older ones a conversion left behind
 *   Access  the role on each board (the role IS the permission, §AA2) and
 *           { build, data } on each artifact (§AA3), and what a click on a
 *           control sends to boardAgentSet / artifactShare
 *
 * WHERE THE LISTS COME FROM. The rules let a client list boards only with
 * where(readerUids array-contains me) and artifacts only with
 * where(memberUids array-contains me) — `agentIds array-contains agentId` is
 * the SERVER's query (an agent token finding its boards), not provable for a
 * person. So both lists are derived from what the owner already reads: their
 * boards (the access map holds agents too — boardsOfAgent in ./agents) and
 * their artifacts (the `agents` map). An agent only ever joins a board through
 * an admin who owns it and an artifact through its owner, so that is the whole
 * list unless the owner has since left the board.
 *
 * Nothing here imports the API or a store — it is all data in, data out.
 */
import {
  agentAccessIsNone,
  agentAccessOf,
  apiKeyActive,
  ARTIFACT_AGENT_FULL,
  type AgentBoardRole,
  type ApiKey,
  type Artifact,
  type ArtifactAgentAccess,
} from '@tm/shared';

// ───────────────────────────────────────────────────────────── board roles

/**
 * The select's order: least to most. (AGENT_BOARD_ROLES in shared is the
 * other way round — it is a vocabulary, not a menu.)
 */
export const AGENT_ROLE_ORDER = [
  'viewer',
  'commenter',
  'editor',
  'admin',
] as const satisfies readonly AgentBoardRole[];

export const AGENT_ROLE_LABEL: Record<AgentBoardRole, string> = {
  viewer: 'Viewer',
  commenter: 'Commenter',
  editor: 'Editor',
  admin: 'Admin',
};

/**
 * One line each, from §AA2's table. No trailing full stop: callers put them
 * in a sentence ("Editor: …."). An agent MAY be admin now; what no agent can
 * do, whatever its role, is said in AGENT_NEVER.
 */
export const AGENT_ROLE_HINT: Record<AgentBoardRole, string> = {
  viewer: 'Read the board, its tickets, threads and files',
  commenter:
    'Read, comment, upload, ask and answer, heartbeat; move tickets inside its stage grant',
  editor: 'Everything a commenter may do, plus create, edit, move, assign, archive and task lists',
  admin:
    'Complete ownership: everything an editor may do, plus board settings, stages, fields, webhooks, restore, and delete where the board allows it',
};

/** §AA2: what an agent cannot do even as admin — those stay with people. */
export const AGENT_NEVER =
  'No agent, even an admin, can manage a board’s people or agents, invite, create boards or mint tokens';

/** A stored role → one the select can show (a stray value reads as viewer, never as more). */
export const agentRoleOf = (role: string | null | undefined): AgentBoardRole =>
  (AGENT_ROLE_ORDER as readonly string[]).includes(role ?? '')
    ? (role as AgentBoardRole)
    : 'viewer';

// ───────────────────────────────────────────────────────────── the token

type KeyLike = Pick<ApiKey, 'actsAs' | 'revokedAt' | 'expiresAt' | 'createdAt'>;

/**
 * Does this key carry an agent's identity? Both shapes count: the §AA1
 * kind 'agent' token, and a legacy kind 'board' key acting as an agent that
 * the migration (§AA6) has not converted yet — it still works, so it is
 * still one of the agent's tokens.
 */
export const isAgentKey = (k: Pick<ApiKey, 'actsAs'>): boolean => k.actsAs?.kind === 'agent';

export interface AgentTokens<T> {
  /** THE token: the newest live one. null = none, offer "Generate token". */
  current: T | null;
  /** Other live tokens (converted older ones), newest first. Empty in the normal case. */
  older: T[];
  /** current + older. */
  live: T[];
}

/**
 * §AA5 — "the one token", and "2 older tokens still work". Live means not
 * revoked and not expired; the newest live one is the token, the rest are the
 * older ones "Revoke older tokens" finishes off.
 */
export function agentTokens<T extends KeyLike>(
  keys: readonly T[],
  agentId: string,
  now = Date.now(),
): AgentTokens<T> {
  const live = keys
    .filter((k) => isAgentKey(k) && k.actsAs.id === agentId && apiKeyActive(k, now))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { current: live[0] ?? null, older: live.slice(1), live };
}

/** '2 older tokens still work' / '1 older token still works' / ''. */
export function olderTokensLabel(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? '1 older token still works' : `${n} older tokens still work`;
}

/** The name a generated token gets: the agent's own (apiKeyCreate takes 1–80 chars). */
export function agentTokenName(agentName: string): string {
  return agentName.trim().slice(0, 80).trim() || 'agent';
}

/** The apiKeyCreate input (§AA1): who the agent is, and nothing else — no board, no scopes. */
export function agentTokenRequest(agentId: string, agentName: string) {
  return {
    kind: 'agent' as const,
    actsAs: { kind: 'agent' as const, id: agentId },
    name: agentTokenName(agentName),
  };
}

// ───────────────────────────────────────────────────────────── artifacts

export type AgentData = ArtifactAgentAccess['data'];
export const AGENT_DATA_ORDER = ['none', 'read', 'write'] as const satisfies readonly AgentData[];
export const AGENT_DATA_LABEL: Record<AgentData, string> = {
  none: 'None',
  read: 'Read',
  write: 'Read & write',
};
export const AGENT_BUILD_HINT = 'Publish builds, roll back and download the source';
export const AGENT_DATA_HINT: Record<AgentData, string> = {
  none: 'Cannot touch the artifact’s database or files',
  read: 'Read the artifact’s database and files through the API',
  write: 'Read and write the artifact’s database and files through the API',
};

/** What "Add to an artifact" starts from: what 'editor' used to mean (§AA3). */
export const NEW_AGENT_ACCESS: ArtifactAgentAccess = { ...ARTIFACT_AGENT_FULL };

/** 'Build · Read & write' / 'Data: read' / 'No access' — for a read-only row. */
export function agentAccessLabel(value: unknown): string {
  const a = agentAccessOf(value);
  if (agentAccessIsNone(a)) return 'No access';
  const parts = [
    ...(a.build ? ['Build'] : []),
    ...(a.data !== 'none' ? [`Data: ${AGENT_DATA_LABEL[a.data].toLowerCase()}`] : []),
  ];
  return parts.join(' · ');
}

export interface AccessChange {
  /** What the row would say after the click. */
  next: ArtifactAgentAccess;
  /** Nothing to send. */
  same: boolean;
  /**
   * The click turned off the LAST permission. { build: false, data: 'none' }
   * is "remove the agent" to artifactShare, so the screen must ASK before it
   * sends this — a checkbox never removes anyone by itself.
   */
  removes: boolean;
}

/**
 * One control changed on an agent's artifact row. `current` is either stored
 * form (the legacy 'editor' reads as build + read & write).
 */
export function changeAccess(current: unknown, patch: Partial<ArtifactAgentAccess>): AccessChange {
  const cur = agentAccessOf(current);
  const next = agentAccessOf({ ...cur, ...patch });
  const same = next.build === cur.build && next.data === cur.data;
  return { next, same, removes: !same && agentAccessIsNone(next) };
}

/** The artifactShare input for an agent (§AA3). Always the object form, never the old role. */
export function artifactAgentShare(
  artifactId: string,
  agentId: string,
  access: ArtifactAgentAccess,
) {
  return { artifactId, agentId, agentAccess: { build: access.build, data: access.data } };
}
/** … and "remove the agent", said explicitly. */
export function artifactAgentRemove(artifactId: string, agentId: string) {
  return artifactAgentShare(artifactId, agentId, { build: false, data: 'none' });
}

type ArtifactLike = Pick<Artifact, 'name' | 'archivedAt' | 'agents' | 'ownerUid'> & { id: string };

export interface AgentArtifactRow<T> {
  artifact: T;
  access: ArtifactAgentAccess;
}

/**
 * The artifacts (that I can see) this agent is on, by name. Archived ones are
 * left out — nothing can be built or written there. A row whose stored value
 * normalises to nothing is "not on it".
 */
export function artifactsOfAgent<T extends ArtifactLike>(
  artifacts: readonly T[],
  agentId: string,
): AgentArtifactRow<T>[] {
  return artifacts
    .filter((a) => a.archivedAt == null)
    .map((a) => ({ artifact: a, access: agentAccessOf(a.agents?.[agentId]) }))
    .filter((r) => !agentAccessIsNone(r.access))
    .sort((a, b) => a.artifact.name.localeCompare(b.artifact.name));
}

/** Artifacts I could add the agent to: I OWN them (artifactShare is owner-only) and it isn't on yet. */
export function artifactsToAddAgent<T extends ArtifactLike>(
  artifacts: readonly T[],
  me: string,
  agentId: string,
): T[] {
  return artifacts
    .filter(
      (a) =>
        a.archivedAt == null &&
        a.ownerUid === me &&
        agentAccessIsNone(agentAccessOf(a.agents?.[agentId])),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
