/**
 * artifactPublish (docs/plan/artifacts.html §C1) — owner or editor: people,
 * and agents on the artifact. The new build becomes current in the same
 * command. Publishing never touches the artifact's data.
 *
 * Exactly one of:
 *   uploadPath  a zip already at artifacts/{id}/uploads/{uploadId}.zip — put
 *               there by the app (Storage rules: owner/editor) or by the REST
 *               door (platform/artifacts.ts) on the caller's behalf;
 *   files       inline [{ path, content, encoding }] — MCP, ≤ 5 MB.
 *
 * ORDER, and why:
 *   1. role check, BEFORE any byte is read
 *   2. unpack + check (artifacts/unzip.ts, publish.ts) → files under
 *      builds/{buildId}/ — a build id nobody else knows yet
 *   3. the source zip, when one came along → source/{buildId}.zip
 *   4. ONE transaction: the role again (it may have been taken away while we
 *      unpacked), builds/{buildId}, currentBuild, updatedAt
 * If anything fails before 4 commits, the half-written build is removed: a
 * build exists only as a document plus its files, never one without the
 * other. The upload zips are single-use and deleted either way.
 */
import {
  ARTIFACT_SOURCE_MAX_BYTES,
  ARTIFACT_ZIP_MAX_BYTES,
  artifactPrefix,
  errors,
  paths,
  type ArtifactBuild,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import {
  assertUploadPath,
  finishPlan,
  planFromInline,
  planFromZip,
  storeBuild,
  type BuildPlan,
} from '../artifacts/publish.js';
import {
  artifactInboxRow,
  artifactRef,
  assertNotArchived,
  buildRef,
  loadArtifact,
} from '../artifacts/shared.js';
import { typedDoc } from '../runtime/converters.js';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { profileOf } from './boardShared.js';

const mb = (n: number) => Math.round(n / 1024 / 1024);

export default defineCommand('artifactPublish', async (ctx, input) => {
  const { artifactId } = input;
  if ((input.uploadPath === undefined) === (input.files === undefined))
    throw errors.invalid('Give exactly one of uploadPath or files');
  if (input.uploadPath) assertUploadPath(artifactId, input.uploadPath, 'uploadPath');
  if (input.sourceUploadPath)
    assertUploadPath(artifactId, input.sourceUploadPath, 'sourceUploadPath');

  const files = ports().files;
  const uploads = [input.uploadPath, input.sourceUploadPath].filter((p): p is string => !!p);
  const buildId = ctx.ids.id();
  const buildPrefix = `${artifactPrefix.storageBuild(artifactId, buildId)}/`;
  const sourcePath = input.sourceUploadPath
    ? artifactPrefix.storageSource(artifactId, buildId)
    : null;
  let plan: BuildPlan | undefined;
  let committed = false;
  // The uploads are only ours to delete once the caller is known to be allowed
  // to publish here — otherwise a stranger could remove somebody's pending zip.
  let authorised = false;

  try {
    const pre = await loadArtifact(null, artifactId, ctx, 'publish');
    authorised = true;
    assertNotArchived(pre.artifact);

    if (input.uploadPath) {
      const stored = await files.stat(input.uploadPath);
      if (!stored) throw errors.invalid('The uploaded zip is not there', { field: 'uploadPath' });
      if (stored.size > ARTIFACT_ZIP_MAX_BYTES)
        throw errors.too_large(`The build zip is over ${mb(ARTIFACT_ZIP_MAX_BYTES)} MB`);
      const zip = await files.read(input.uploadPath);
      // A view, not a copy: the zip is up to 26 MB and lives until the build is stored.
      plan = await planFromZip(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
    } else {
      plan = planFromInline(input.files!);
    }
    const stored = await storeBuild(artifactId, buildId, finishPlan(plan.files));

    if (input.sourceUploadPath && sourcePath) {
      const src = await files.stat(input.sourceUploadPath);
      if (!src)
        throw errors.invalid('The uploaded source zip is not there', { field: 'sourceUploadPath' });
      if (src.size > ARTIFACT_SOURCE_MAX_BYTES)
        throw errors.too_large(`The source zip is over ${mb(ARTIFACT_SOURCE_MAX_BYTES)} MB`);
      await files.copy(input.sourceUploadPath, sourcePath);
    }

    const build: ArtifactBuild = {
      files: stored.files,
      bytes: stored.bytes,
      message: input.message || null,
      sourcePath,
      by: ctx.actor,
      createdAt: ctx.now,
      warnings: stored.warnings,
    };
    const { artifact } = await runTx(async (tx) => {
      const cur = await loadArtifact(tx, artifactId, ctx, 'publish');
      assertNotArchived(cur.artifact);
      tx.create(buildRef(artifactId, buildId), build);
      tx.update(artifactRef(artifactId), { currentBuild: buildId, updatedAt: ctx.now });
      return cur;
    });
    committed = true;

    // §F: the owner hears about a build somebody else published. In-app only,
    // and never allowed to fail the publish.
    if (artifact.ownerUid !== ctx.actor) {
      const who = (await profileOf(ctx.ownerUid ?? ctx.actor)).name;
      await typedDoc('inbox', paths.inboxItem(artifact.ownerUid, `artifact_${artifactId}_build`))
        .set(
          artifactInboxRow(
            artifactId,
            'updated',
            `${ctx.keyName ? `${who} (via token ${ctx.keyName})` : who} published a new build of “${artifact.name}”`,
            ctx,
          ),
        )
        .catch((e) => console.warn('[artifactPublish] inbox row failed', e));
    }
    return { buildId, files: stored.files, bytes: stored.bytes, warnings: stored.warnings };
  } finally {
    plan?.close();
    if (!committed) {
      await files.deletePrefix(buildPrefix).catch(() => {});
      if (sourcePath) await files.delete(sourcePath).catch(() => {});
    }
    if (authorised) for (const p of uploads) await files.delete(p).catch(() => {});
  }
});
