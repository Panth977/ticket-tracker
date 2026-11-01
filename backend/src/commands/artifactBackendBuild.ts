/**
 * artifactBackendBuild: compile on the worker, in the sandbox, under its CPU limits. A
 * good build with publish: true is stored and goes live; the gateway drops the old one.
 */
import {
  ARTIFACT_BACKEND_ENTRY,
  ARTIFACT_BACKEND_MAX_BYTES,
  artifactPrefix,
  errors,
  type ArtifactBackend,
  type ArtifactBackendDiagnostic,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { forgetBackendListeners } from '../artifacts/backendEvents.js';
import { gatewayCall } from '../artifacts/gateway.js';
import { artifactRef, assertNotArchived, loadArtifact } from '../artifacts/shared.js';
import { defineCommand } from './_registry.js';

interface Compiled {
  ok: boolean;
  diagnostics: ArtifactBackendDiagnostic[];
  routes: string[];
  events: string[];
  cpuMs: number;
  compiledCode?: unknown;
}

export default defineCommand('artifactBackendBuild', async (ctx, input) => {
  const { artifactId, files, publish } = input;
  const { artifact } = await loadArtifact(null, artifactId, ctx, 'publish');
  assertNotArchived(artifact);
  if (!files.some((f) => f.path === ARTIFACT_BACKEND_ENTRY))
    throw errors.invalid(`A backend needs ${ARTIFACT_BACKEND_ENTRY}`);
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (bytes > ARTIFACT_BACKEND_MAX_BYTES) throw errors.too_large('Backend source is over 2 MB');

  const r = await gatewayCall<Compiled>('compile', { artifactId, files });
  const res = { ok: r.ok, diagnostics: r.diagnostics, routes: r.routes, events: r.events, cpuMs: r.cpuMs, buildId: null as string | null };
  if (!r.ok || !publish) return res;

  const buildId = ctx.ids.id();
  await ports().files.write(
    artifactPrefix.storageBackend(artifactId, buildId),
    Buffer.from(JSON.stringify({ files, compiledCode: r.compiledCode })),
    'application/json',
  );
  const backend: ArtifactBackend = {
    buildId,
    routes: r.routes,
    events: r.events,
    publishedAt: ctx.now,
  };
  await artifactRef(artifactId).update({ backend, backendBoards: Object.keys(artifact.boards ?? {}), updatedAt: ctx.now });
  forgetBackendListeners();
  await gatewayCall('reload', { artifactId }, 15_000).catch(() => undefined);
  return { ...res, buildId };
});
