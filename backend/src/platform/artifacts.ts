/**
 * ARTIFACTS over REST and MCP (docs/plan/artifacts.html §C1, §C2) — the
 * operations both doors share, in the same arrangement as the rest of the
 * platform (ops.ts, account.ts):
 *
 *   WRITES are the app's own commands, through the runner (invoke): the role
 *     check, the unpacking, the transaction all happen there, once.
 *   READS (list, get) are done here, in the door, and answer PUBLIC shapes
 *     (shared api/public.ts) — the app reads the same documents straight from
 *     Firestore under the rules; a token cannot, so the door reads for it and
 *     applies the same role (artifacts/shared.ts roleFor).
 *
 * WHAT A TOKEN REACHES (§C4): an account token, the artifacts its person owns
 * or edits; an agent token, the artifacts that agent was added to. The list
 * is resolved at each call and never stored. What an AGENT may do on each is
 * its { build, data } there (agents.html §AA3) — shown to it as `agent_access`
 * on every artifact it is answered, and to the owner on each agent member.
 *
 * PUBLISHING A ZIP OVER HTTP. The command takes a path to a zip already in
 * Storage — that is how the app publishes. A token has no Storage session, so
 * the door does that one step on its behalf: it checks the role FIRST, writes
 * the bytes to the same uploads/ prefix the app would have used, and calls
 * artifactPublish. No second code path: the zip is checked by the one command.
 */
import {
  agentAccessOf,
  ARTIFACT_AGENT_DATA,
  ARTIFACT_SOURCE_MAX_BYTES,
  ARTIFACT_ZIP_MAX_BYTES,
  artifactPrefix,
  errors,
  isAgentId,
  toIso,
  type Artifact,
  type ArtifactAgentAccess,
  type ArtifactBuild,
  type ArtifactRole,
  type PublicActor,
  type PublicArtifact,
  type PublicArtifactBuild,
  type PublicArtifactDetail,
  type PublicArtifactMember,
} from '@tm/shared';
import { agentRef } from '../agents/shared.js';
import {
  agentAccessFor,
  artifactAppPath,
  artifactRef,
  artifactsCol,
  assertNotArchived,
  buildsCol,
  loadArtifact,
  roleFor,
} from '../artifacts/shared.js';
import { appUrl, profileOf } from '../commands/boardShared.js';
import type { ServerCtx } from '../runtime/context.js';
import { storageAdmin } from '../runtime/firebase.js';
import { invoke } from './ops.js';

const iso = (ms: number): string => toIso(ms)!;

/** `agentAccess`: the CALLER's, when the caller is an agent (§AA3) — absent for a person. */
export function toPublicArtifact(
  id: string,
  a: Artifact,
  role: ArtifactRole,
  agentAccess?: ArtifactAgentAccess | null,
): PublicArtifact {
  return {
    id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    url: `${appUrl()}${artifactAppPath(id)}`,
    role,
    ...(agentAccess ? { agent_access: agentAccess } : {}),
    read_only: a.readOnly,
    archived: a.archivedAt !== null,
    current_build: a.currentBuild,
    owner_id: a.ownerUid,
    created_at: iso(a.createdAt),
    updated_at: iso(a.updatedAt),
  };
}

export function toPublicBuild(
  id: string,
  b: ArtifactBuild,
  by: PublicActor,
  current: string | null,
): PublicArtifactBuild {
  return {
    id,
    files: b.files,
    bytes: b.bytes,
    message: b.message,
    by,
    created_at: iso(b.createdAt),
    warnings: b.warnings,
    has_source: !!b.sourcePath,
    current: id === current,
  };
}

/** Names for a handful of principals (people from users/ or Auth, agents from agents/). */
async function names(
  ids: readonly string[],
): Promise<Map<string, { name: string; email: string }>> {
  const out = new Map<string, { name: string; email: string }>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      if (isAgentId(id)) {
        const agent = (await agentRef(id).get()).data();
        out.set(id, { name: agent?.name ?? 'Agent', email: '' });
      } else {
        const p = await profileOf(id);
        out.set(id, { name: p.name, email: p.email });
      }
    }),
  );
  return out;
}

const actor = (id: string, who: Map<string, { name: string }>): PublicActor => ({
  id,
  kind: isAgentId(id) ? 'agent' : 'user',
  name: who.get(id)?.name ?? 'Someone',
});

/**
 * GET /v1/artifacts, MCP artifact_list — everything this credential reaches,
 * most recently changed first.
 *
 * A person's are found by the same query the app uses (memberUids
 * array-contains); an agent's by the `agents.{id}` map key, which only the
 * Admin SDK can ask (rules could not prove it — and no client needs to).
 *
 * §AA3: that value is an object now, so an agent's artifacts are the union of
 * two equality-shaped queries on the automatic single-field indexes — the
 * object form (`agents.{id}.data` is always one of three words) and the
 * pre-§AA literal 'editor', until the migration has rewritten every row.
 * roleFor then drops anything that says { build: false, data: 'none' }.
 */
export async function listArtifacts(ctx: ServerCtx): Promise<PublicArtifact[]> {
  const col = artifactsCol();
  const docs = isAgentId(ctx.actor)
    ? (
        await Promise.all([
          col.where(`agents.${ctx.actor}.data`, 'in', [...ARTIFACT_AGENT_DATA]).get(),
          col.where(`agents.${ctx.actor}`, '==', 'editor').get(),
        ])
      ).flatMap((s) => s.docs)
    : (await col.where('memberUids', 'array-contains', ctx.actor).get()).docs;
  return docs
    .flatMap((d) => {
      const role = roleFor(ctx, d.data());
      return role
        ? [{ a: d.data(), pub: toPublicArtifact(d.id, d.data(), role, agentAccessFor(ctx, d.data())) }]
        : [];
    })
    .sort((x, y) => y.a.updatedAt - x.a.updatedAt)
    .map((x) => x.pub);
}

/** GET /v1/artifacts/{id}, MCP artifact_get. */
export async function artifactDetail(
  ctx: ServerCtx,
  artifactId: string,
): Promise<PublicArtifactDetail> {
  const { artifact, role, agentAccess } = await loadArtifact(null, artifactId, ctx, 'open');
  const builds = (await buildsCol(artifactId).orderBy('createdAt', 'desc').get()).docs;
  const who = await names([
    ...Object.keys(artifact.access),
    ...Object.keys(artifact.agents),
    ...builds.map((b) => b.data().by),
  ]);
  const members: PublicArtifactMember[] = [
    ...Object.entries(artifact.access).map(([id, r]) => ({
      id,
      kind: 'user' as const,
      name: who.get(id)?.name ?? 'Someone',
      email: who.get(id)?.email ?? '',
      role: r,
    })),
    // §AA3: an agent member says what it may do here; `role` stays 'editor' for older clients.
    ...Object.entries(artifact.agents).map(([id, stored]) => ({
      id,
      kind: 'agent' as const,
      name: who.get(id)?.name ?? 'Agent',
      email: '',
      role: 'editor' as const,
      agent_access: agentAccessOf(stored),
    })),
  ];
  return {
    ...toPublicArtifact(artifactId, artifact, role, agentAccess),
    builds: builds.map((b) =>
      toPublicBuild(b.id, b.data(), actor(b.data().by, who), artifact.currentBuild),
    ),
    members,
  };
}

/** The artifact as the caller sees it now (after a write). */
export async function artifactView(ctx: ServerCtx, artifactId: string): Promise<PublicArtifact> {
  const { artifact, role, agentAccess } = await loadArtifact(null, artifactId, ctx, 'open');
  return toPublicArtifact(artifactId, artifact, role, agentAccess);
}

/** One build as a public shape (after a publish). */
export async function buildView(
  ctx: ServerCtx,
  artifactId: string,
  buildId: string,
): Promise<PublicArtifactBuild> {
  const [b, a] = await Promise.all([
    buildsCol(artifactId).doc(buildId).get(),
    artifactRef(artifactId).get(),
  ]);
  const build = b.data();
  if (!build) throw errors.internal('The build was published but cannot be read back');
  const who = await names([build.by]);
  return toPublicBuild(buildId, build, actor(build.by, who), a.data()?.currentBuild ?? null);
}

/**
 * Publish from bytes that arrived over HTTP (POST /v1/artifacts/{id}/builds).
 * See the header: role first, then the same uploads/ prefix the app uses,
 * then THE command — which deletes the uploads whatever happens.
 */
export async function publishZip(
  ctx: ServerCtx,
  artifactId: string,
  input: { zip: Uint8Array; source?: Uint8Array | undefined; message?: string | undefined },
  key?: string,
): Promise<PublicArtifactBuild> {
  if (input.zip.length === 0) throw errors.invalid('The request has no zip in it');
  if (input.zip.length > ARTIFACT_ZIP_MAX_BYTES)
    throw errors.too_large(`The build zip is over ${ARTIFACT_ZIP_MAX_BYTES / 1024 / 1024} MB`);
  if (input.source && input.source.length > ARTIFACT_SOURCE_MAX_BYTES)
    throw errors.too_large(`The source zip is over ${ARTIFACT_SOURCE_MAX_BYTES / 1024 / 1024} MB`);
  const { artifact } = await loadArtifact(null, artifactId, ctx, 'publish');
  assertNotArchived(artifact);

  const bucket = storageAdmin().bucket();
  const put = async (bytes: Uint8Array): Promise<string> => {
    const path = artifactPrefix.storageUpload(artifactId, ctx.ids.id());
    await bucket
      .file(path)
      // A VIEW of the request's bytes, not a copy: a build zip is up to 26 MB.
      .save(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        contentType: 'application/zip',
        resumable: false,
      });
    return path;
  };
  const uploadPath = await put(input.zip);
  const sourceUploadPath = input.source?.length ? await put(input.source) : undefined;
  try {
    const res = await invoke(
      'artifactPublish',
      {
        artifactId,
        uploadPath,
        ...(sourceUploadPath ? { sourceUploadPath } : {}),
        ...(input.message ? { message: input.message } : {}),
      },
      ctx,
      key ?? null,
    );
    return await buildView(ctx, artifactId, res.buildId);
  } finally {
    // The command removes them itself; a REPLAYED request (Idempotency-Key)
    // never reaches the command, so the door clears what it stored.
    for (const p of [uploadPath, sourceUploadPath])
      if (p)
        await bucket
          .file(p)
          .delete({ ignoreNotFound: true })
          .catch(() => {});
  }
}
