/**
 * The worker's gateway, from TaskManager's side (backend.ts in shared). The gateway
 * holds the sandboxes, because a sandbox lives on one open connection and a function
 * cannot keep one. Unset TM_GATEWAY_URL = this deploy has no backends.
 */
import { timingSafeEqual } from 'node:crypto';
import { errors } from '@tm/shared';

export const gatewayUrl = (): string | null => process.env.TM_GATEWAY_URL?.replace(/\/$/, '') || null;
const secret = (): string => process.env.TM_GATEWAY_SECRET ?? '';

export function gatewayConfigured(): boolean {
  return !!gatewayUrl() && !!secret();
}

/** One internal call to the gateway. */
export async function gatewayCall<T>(path: string, body: unknown, timeoutMs = 240_000): Promise<T> {
  const base = gatewayUrl();
  if (!base || !secret()) throw errors.unavailable('This deploy has no backend worker');
  let res: Response;
  try {
    res = await fetch(`${base}/internal/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw errors.unavailable('The backend worker is not reachable');
  }
  if (!res.ok) throw errors.unavailable(`The backend worker answered ${res.status}`);
  return (await res.json()) as T;
}

/** Is this the gateway calling? Constant time; no secret, no access. */
export function isGateway(header: string | undefined): boolean {
  const want = secret();
  if (!want || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${want}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
