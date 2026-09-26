/**
 * Hono environment shared by every door: the request id (for logs and the
 * problem `instance`) and, after an auth middleware ran, the command ctx.
 */
import type { ServerCtx } from '../runtime/context.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    /** Set by an auth middleware (user / apiKey / oauth). */
    ctx: ServerCtx;
  };
}
