/**
 * The app door: POST /api/{command} with a Firebase ID token.
 * The body is the command's Req JSON; the answer is its Res JSON (200) or
 * problem+json. Only POST: commands change things, and a GET must never.
 */
import { errors } from '@tm/shared';
import { USAGE_ROUTE } from '@tm/shared/api/usage';
import { door } from '../http/mounts.js';
import { userAuth } from '../middleware/user.js';
import { assertAdmin } from '../platform/allow.js';
import { readUsage } from '../platform/usage.js';
import { runCommand } from '../runtime/runner.js';

/** Commands carry JSON, never files (uploads go straight to Storage). */
export const MAX_COMMAND_BYTES = 1024 * 1024;

const api = door('api');

/**
 * GET /api/usage — what this project is costing (agents.html §X).
 *
 * It lives HERE, above /:command, for one reason: it is a one-segment path, so
 * the "commands are POST only" catch-all below would swallow it if it were
 * registered anywhere else (a two-segment route like /api/files/url is safe in
 * its own module; this one is not).
 *
 * A GET because it changes nothing, and admin-only because it is the project's
 * bill. `?refresh=1` skips the hourly cache — the one way to pay for a
 * Monitoring query on purpose.
 */
api.get(USAGE_ROUTE.slice('/api'.length), userAuth, async (c) => {
  const ctx = c.get('ctx');
  assertAdmin(ctx.email, ctx.emailVerified);
  c.header('cache-control', 'no-store');
  return c.json(await readUsage({ refresh: c.req.query('refresh') === '1', now: ctx.now }));
});

api.post('/:command', userAuth, async (c) => {
  let body: unknown = {};
  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw errors.too_large('Command body over 1 MB');
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw errors.invalid('Body is not valid JSON');
    }
  }
  const res = await runCommand(c.req.param('command'), body, c.get('ctx'));
  return c.json(res as object, 200);
});

api.all('/:command', () => {
  throw errors.invalid('Commands are POST only');
});
