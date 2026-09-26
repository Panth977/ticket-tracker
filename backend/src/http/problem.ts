/**
 * RFC 9457 problem+json responses from AppError — the one error shape every
 * HTTP door answers with.
 */
import type { Context } from 'hono';
import { PROBLEM_CONTENT_TYPE, type AppError } from '@tm/shared';
import { toAppError } from '../runtime/runner.js';
import type { AppEnv } from './env.js';

export function problemResponse(
  err: AppError,
  instance?: string,
  headers: Record<string, string> = {},
): Response {
  const body = err.toProblem(instance);
  const h: Record<string, string> = { 'content-type': PROBLEM_CONTENT_TYPE, ...headers };
  // 429s carry Retry-After (seconds) when the thrower said how long.
  const retryAfter = err.details?.retryAfter;
  if (err.code === 'rate_limited' && typeof retryAfter === 'number')
    h['retry-after'] = String(Math.ceil(retryAfter));
  return new Response(JSON.stringify(body), { status: err.status, headers: h });
}

/** Hono onError handler: anything thrown in a route becomes problem+json. */
export function onError(err: unknown, c: Context<AppEnv>): Response {
  const rid = c.get('requestId');
  return problemResponse(toAppError(err), rid ? `urn:request:${rid}` : undefined);
}
