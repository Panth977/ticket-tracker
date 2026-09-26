/**
 * The hono app behind `export const api = onRequest(...)`. One function
 * serves every door; hosting rewrites (/api/**, /v1/**, /mcp, /oauth/**,
 * /hooks/**, /.well-known/**) all land here.
 */
import { Hono } from 'hono';
import { errors } from '@tm/shared';
import { autoload } from '../runtime/autoload.js';
import { ports } from '../adapters/index.js';
import { registeredCommandNames, unimplementedCommands } from '../commands/_registry.js';
import { isEmulated } from '../runtime/firebase.js';
import type { AppEnv } from './env.js';
import { doorRouters, MOUNTS } from './mounts.js';
import { onError, problemResponse } from './problem.js';

export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const rid =
      c.req.header('x-request-id') ||
      c.req.header('x-cloud-trace-context')?.split('/')[0] ||
      ports().ids.id();
    c.set('requestId', rid);
    await next();
    c.header('x-request-id', rid);
  });

  // Liveness + (under the emulators) which commands are wired — handy while steps land.
  app.get('/api/_status', (c) =>
    c.json({
      ok: true,
      ...(isEmulated()
        ? { commands: registeredCommandNames(), unimplemented: unimplementedCommands() }
        : {}),
    }),
  );

  for (const [name, router] of doorRouters()) app.route(MOUNTS[name], router);

  app.notFound((c) =>
    problemResponse(errors.not_found(`No route for ${c.req.method} ${c.req.path}`)),
  );
  app.onError(onError);
  return app;
}

let appPromise: Promise<Hono<AppEnv>> | undefined;

/** Load every handler / door module, then build the app (once per process). */
export function createApp(): Promise<Hono<AppEnv>> {
  return (appPromise ??= autoload().then(buildApp));
}
