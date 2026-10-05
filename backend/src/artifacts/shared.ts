/**
 * ARTIFACTS (docs/plan/artifacts.html) — what every artifact command shares.
 * Not a command and not in commands/: handlers, the /c door, REST/MCP and the
 * delete job all import it.
 *
 *   artifactRef / buildRef   typed references (the shapes are shared's)
 *   roleFor / loadArtifact   WHO IS THIS, HERE — the one place a role is decided
 *   withMembers              memberUids derived from access (never written alone)
 *   syncArtifactMirror       the RTDB mirror the database rules read
 *   artifactInboxRow         'shared with you' / 'new build' in the in-app inbox
 *
 * AN ARTIFACT IS NOT A BOARD (§A, §B). Its people are its own: being on a
 * board gives nothing here, so nothing in this file asks can() — the role is
 * read from the artifact document and from nowhere else.
 *
 *   a PERSON   artifacts/{id}.access[uid]        owner | editor | viewer
 *   an AGENT   artifacts/{id}.agents[agentId]    { build, data } (agents.html §AA3)
 *
 * AN AGENT'S TWO PERMISSIONS (§AA3), read with shared's agentAccessOf so the
 * pre-§AA literal 'editor' means { build: true, data: 'write' }:
 *   build   publish, roll back, download the source        → need 'publish'
 *   data    'read' | 'write': the data API (§AA4)          → need 'readData' / 'writeData'
 *   any of them                                            → need 'open' (list, get)
 *   never                                                  → need 'manage' (share, rename, delete)
 * For PublicArtifact.role an agent with any permission still reads 'editor'
 * (older clients); what it may do is LoadedArtifact.agentAccess.
 *
 * TOKENS only narrow (§C4). An account token reaches the artifacts where its
 * person is OWNER OR EDITOR — a viewer's token sees nothing, because a token
 * has no browser to view with. An agent token reaches exactly the artifacts
 * that agent was added to. A board token acting as a person reaches none: it
 * was issued for one board, and an artifact is not on a board.
 *
 * NO ROLE IS A 404, NOT A 403: artifacts are private, and "you may not" would
 * confirm that the id exists.
 */
import {
  agentAccessOf,
  ARTIFACT_INVITE_BOARD_ID,
  ArtifactPathError,
  artifactAgentCan,
  artifactCan,
  artifactPrefix,
  COLLECTIONS,
  errors,
  isAgentId,
  type Artifact,
  type ArtifactAgentAccess,
  type ArtifactRole,
  type InboxItem,
  type NotifyEvent,
  type Uid,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { rtdbAdmin } from '../runtime/firebase.js';
import { txGet, type Tx } from '../runtime/tx.js';

const C = COLLECTIONS;

export const artifactPath = (artifactId: string) => `${C.artifacts}/${artifactId}`;
export const buildsPath = (artifactId: string) => `${artifactPath(artifactId)}/${C.builds}`;

export const artifactsCol = () => typedCol('artifacts', C.artifacts);
export const artifactRef = (artifactId: string) => typedDoc('artifacts', artifactPath(artifactId));
export const buildsCol = (artifactId: string) => typedCol('artifactBuilds', buildsPath(artifactId));
export const buildRef = (artifactId: string, buildId: string) =>
  typedDoc('artifactBuilds', `${buildsPath(artifactId)}/${buildId}`);

/**
 * What a command needs from the caller — the columns of the §B table, plus
 * §AA4's two for the data API: 'readData' and 'writeData'.
 */
export type ArtifactNeed = 'open' | 'publish' | 'manage' | 'readData' | 'writeData';

/** Own keys only: a uid is any string, and 'constructor' must not find Object's. */
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** A board-scoped API key acting as its person (keyId set, one board) — see the header. */
const isBoardTokenAsPerson = (ctx: Pick<ServerCtx, 'actor' | 'keyId' | 'boardIds'>): boolean =>
  !isAgentId(ctx.actor) && !!ctx.keyId && ctx.boardIds !== null && ctx.boardIds !== undefined;

/**
 * The caller's role on this artifact, or null. Pure: the same answer for the
 * command layer, the REST list and the MCP tools.
 */
export function roleFor(
  ctx: Pick<ServerCtx, 'actor' | 'scopes' | 'keyId' | 'boardIds'>,
  artifact: Pick<Artifact, 'access' | 'agents' | 'deletingAt'>,
): ArtifactRole | null {
  // Being deleted: gone for everyone, the owner included (the job is already running).
  if (artifact.deletingAt) return null;
  // §AA3: an agent with ANY permission is "on it"; { build: false, data: 'none' } is not.
  if (isAgentId(ctx.actor))
    return artifactAgentCan.open(own(artifact.agents, ctx.actor)) ? 'editor' : null;
  if (isBoardTokenAsPerson(ctx)) return null;
  const role = own(artifact.access, ctx.actor) ?? null;
  // §C4: a token reaches what its person OWNS OR EDITS.
  if (ctx.scopes && role === 'viewer') return null;
  return role;
}

/**
 * The calling AGENT's { build, data } here, or null when the caller is a
 * person. Pure, like roleFor.
 */
export function agentAccessFor(
  ctx: Pick<ServerCtx, 'actor'>,
  artifact: Pick<Artifact, 'agents'>,
): ArtifactAgentAccess | null {
  return isAgentId(ctx.actor) ? agentAccessOf(own(artifact.agents, ctx.actor)) : null;
}

/** A PERSON's answers, by role. Data writes follow §B: a viewer unless the artifact is read-only. */
const ALLOWS: Record<ArtifactNeed, (r: ArtifactRole, a: Pick<Artifact, 'readOnly'>) => boolean> = {
  open: (r) => artifactCan.open(r),
  publish: (r) => artifactCan.publish(r),
  manage: (r) => artifactCan.manage(r),
  readData: (r) => artifactCan.readData(r),
  writeData: (r, a) => artifactCan.writeData(r, a.readOnly),
};
/** An AGENT's answers (§AA3), by its { build, data }. */
const AGENT_ALLOWS: Record<ArtifactNeed, (a: ArtifactAgentAccess) => boolean> = {
  open: artifactAgentCan.open,
  publish: artifactAgentCan.build,
  manage: artifactAgentCan.manage,
  readData: artifactAgentCan.readData,
  writeData: artifactAgentCan.writeData,
};
const REFUSAL: Record<ArtifactNeed, string> = {
  open: 'You cannot open this artifact',
  publish: 'Only the owner and editors can publish or roll back',
  manage: 'Only the owner can do that',
  readData: "You cannot read this artifact's data",
  writeData: 'This artifact is read-only for viewers',
};
const AGENT_REFUSAL: Record<ArtifactNeed, string> = {
  open: 'This agent cannot open this artifact',
  publish:
    'This agent has no build permission on this artifact — its owner can give it (People › the agent › Build)',
  manage: 'An agent cannot share, rename or delete an artifact — only its owner can',
  readData:
    "This agent has no data permission on this artifact — its owner can give it (People › the agent › Data)",
  writeData:
    "This agent may not write this artifact's data — its owner can set Data to 'write' (People › the agent › Data)",
};

export interface LoadedArtifact {
  artifact: Artifact;
  role: ArtifactRole;
  /** §AA3: the calling agent's { build, data }; null when a person is calling. */
  agentAccess: ArtifactAgentAccess | null;
}

function gate(data: Artifact | undefined, ctx: ServerCtx, need: ArtifactNeed): LoadedArtifact {
  const role = data ? roleFor(ctx, data) : null;
  if (!data || !role) {
    // Say WHY only when it is about the credential, never about the artifact.
    if (data && isBoardTokenAsPerson(ctx) && own(data.access, ctx.actor))
      throw errors.forbidden(
        'A board token cannot reach artifacts — use an account token (Account › Tokens)',
      );
    throw errors.not_found('Artifact not found');
  }
  const agentAccess = agentAccessFor(ctx, data);
  if (agentAccess) {
    if (!AGENT_ALLOWS[need](agentAccess)) throw errors.forbidden(AGENT_REFUSAL[need]);
  } else if (!ALLOWS[need](role, data)) throw errors.forbidden(REFUSAL[need]);
  return { artifact: data, role, agentAccess };
}

/** Read an artifact (in `tx` when given) and gate it: 404 without a role, 403 with too low a one. */
export async function loadArtifact(
  tx: Tx | null,
  artifactId: string,
  ctx: ServerCtx,
  need: ArtifactNeed,
): Promise<LoadedArtifact> {
  const ref = artifactRef(artifactId);
  const data = tx ? await txGet(tx, ref) : (await ref.get()).data();
  return gate(data, ctx, need);
}

/** Archived: no data writes, no publishing — until the owner restores it. */
export function assertNotArchived(artifact: Pick<Artifact, 'archivedAt'>): void {
  if (artifact.archivedAt !== null)
    throw errors.conflict('This artifact is archived — restore it first');
}

/** `access` with its derived list. The ONLY way memberUids is ever computed. */
export function withMembers(access: Record<Uid, ArtifactRole>): {
  access: Record<Uid, ArtifactRole>;
  memberUids: Uid[];
} {
  return { access, memberUids: Object.keys(access).sort() };
}

/**
 * THE RTDB MIRROR (§E4). Database rules cannot read Firestore, so what they
 * need is copied beside the data, after the Firestore commit — the same
 * mechanism as boardReaders (commands/boardShared.ts syncReaders), and for
 * the same reason written whole, so it can never drift by more than one
 * write:
 *
 *   artifactReaders/{id}/{uid} = 'owner' | 'editor' | 'viewer'
 *   artifactFlags/{id}         = { readOnly, archived }
 *
 * A viewer's write depends on BOTH (their role, and the artifact not being
 * read-only or archived), which is why the flags travel too. Agents are never
 * mirrored: they do not sign in to the database. Housekeeping re-runs this for
 * every artifact nightly, so a mirror write that failed heals by morning.
 */
export async function syncArtifactMirror(
  artifactId: string,
  artifact: Pick<Artifact, 'access' | 'readOnly' | 'archivedAt' | 'deletingAt'> | null,
): Promise<void> {
  const r = rtdbAdmin();
  const readers = r.ref(artifactPrefix.rtdbReaders(artifactId));
  const flags = r.ref(artifactPrefix.rtdbFlags(artifactId));
  const people = artifact && !artifact.deletingAt ? Object.entries(artifact.access) : [];
  if (!artifact || people.length === 0) {
    await Promise.all([readers.remove(), flags.remove()]);
    return;
  }
  await Promise.all([
    readers.set(Object.fromEntries(people)),
    flags.set({ readOnly: artifact.readOnly, archived: artifact.archivedAt !== null }),
  ]);
}

/** Where a person opens an artifact in the app (the host page of §D3). */
export const artifactAppPath = (artifactId: string) => `/x/${artifactId}`;

/**
 * An inbox row about an artifact. Written directly, not through notify():
 * the router is board-shaped (prefs, roles and watchers of a board), and an
 * artifact has none of those. In-app only — see the final note in
 * commands/artifactShare.ts.
 */
export function artifactInboxRow(
  artifactId: string,
  event: NotifyEvent,
  summary: string,
  ctx: Pick<ServerCtx, 'actor' | 'via' | 'now'>,
  extra: { inviteId?: string | null; groupKey?: string } = {},
): InboxItem {
  return {
    event,
    boardId: ARTIFACT_INVITE_BOARD_ID,
    ticketId: null,
    ticketKey: null,
    ticketTitle: null,
    inviteId: extra.inviteId ?? null,
    actor: ctx.actor,
    via: ctx.via,
    summary,
    groupKey: extra.groupKey ?? `artifact:${artifactId}:${event}`,
    count: 1,
    createdAt: ctx.now,
    readAt: null,
    archivedAt: null,
    snoozedUntil: null,
    artifactId,
  };
}

/**
 * Run one of the path-fence functions (shared artifacts/paths.ts). Its refusal
 * is the caller's mistake — a 400 naming the path, never a 500.
 */
export function fenced<T>(fn: () => T, field = 'path'): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ArtifactPathError) throw errors.invalid(e.message, { field });
    throw e;
  }
}
