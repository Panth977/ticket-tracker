/**
 * /hooks/gateway: the worker's door into TaskManager (shared/artifacts/backend.ts). Only
 * the gateway's secret opens it, and it can only read live backends and run host ops.
 *
 *   GET  /hooks/gateway/artifacts/{id}        what is live: routes, events, compiledCode
 *   POST /hooks/gateway/artifacts/{id}/host   { op, input } as the artifact
 */
import { artifactPrefix, isAppError, type Artifact } from '@tm/shared';
import { ports } from '../../adapters/index.js';
import { isGateway } from '../../artifacts/gateway.js';
import { runHostOp } from '../../artifacts/backendHost.js';
import { artifactRef } from '../../artifacts/shared.js';
import { door } from '../../http/mounts.js';

const hooks = door('hooks');

hooks.get('/gateway/artifacts/:id', async (c) => {
  if (!isGateway(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const snap = await artifactRef(id).get();
  const a = snap.data() as Artifact | undefined;
  if (!a?.backend || a.deletingAt || a.archivedAt !== null) return c.json({ live: false });
  const stored = await ports().files.read(artifactPrefix.storageBackend(id, a.backend.buildId));
  const { compiledCode } = JSON.parse(Buffer.from(stored).toString('utf8')) as { compiledCode: unknown };
  return c.json({ live: true, buildId: a.backend.buildId, routes: a.backend.routes, events: a.backend.events, compiledCode });
});

hooks.post('/gateway/artifacts/:id/host', async (c) => {
  if (!isGateway(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401);
  const { op, input } = (await c.req.json()) as { op: string; input: Record<string, unknown> };
  try {
    return c.json({ ok: true, value: await runHostOp(c.req.param('id'), op, input ?? {}) });
  } catch (e) {
    if (isAppError(e)) return c.json({ ok: false, code: e.code, message: e.message });
    throw e;
  }
});

