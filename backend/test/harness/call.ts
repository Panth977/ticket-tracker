/**
 * call(user, command, input) — invoke a command exactly as the app does:
 * POST /api/{command} with the user's ID token, through the real hono app.
 *
 * In-process by default (fast, and tests can swap ports). Set TM_API_URL to
 * go over the wire instead, e.g. against the functions emulator:
 *   TM_API_URL=http://127.0.0.1:5101/demo-taskmanager/us-central1/api
 */
import {
  fromProblem,
  type AppError,
  type CommandName,
  type CommandReq,
  type CommandRes,
} from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import type { TestUser } from './users.js';

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/** Any HTTP request against the api function (path like '/api/ping' or '/v1/boards'). */
export async function request(path: string, init: RequestInit = {}): Promise<RawResponse> {
  const base = process.env.TM_API_URL;
  const res = base
    ? await fetch(base.replace(/\/$/, '') + path, init)
    : await (await createApp()).request(path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — keep text */
  }
  return { status: res.status, headers: res.headers, body };
}

/** POST /api/{command}; returns the raw response (status, headers, body). */
export function callRaw(
  user: TestUser | null,
  command: string,
  input: unknown = {},
): Promise<RawResponse> {
  return request(`/api/${command}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(user ? { authorization: `Bearer ${user.token}` } : {}),
    },
    body: JSON.stringify(input),
  });
}

/**
 * Typed call: resolves with the command's Res, rejects with the AppError the
 * problem+json describes — `await expect(call(u, 'x', {})).rejects.toMatchObject({ code: 'forbidden' })`.
 * Local (non-contract) commands like 'ping' are allowed with loose types.
 */
export async function call<N extends CommandName>(
  user: TestUser | null,
  command: N,
  input: CommandReq<N>,
): Promise<CommandRes<N>>;
export async function call(
  user: TestUser | null,
  command: string,
  input?: unknown,
): Promise<unknown>;
export async function call(
  user: TestUser | null,
  command: string,
  input: unknown = {},
): Promise<unknown> {
  const res = await callRaw(user, command, input);
  if (res.status >= 400) {
    const err: AppError & { status?: number } = fromProblem(res.body);
    throw err;
  }
  return res.body;
}
