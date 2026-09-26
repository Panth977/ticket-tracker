/**
 * POST to a backend endpoint that is not an /api command — the OAuth consent
 * endpoints (/oauth/consent/*) and installConnect (/integrations/{p}/connect).
 * Same auth and problem+json handling as `command()`, but untyped.
 */
import { AppError, codeForStatus, fromProblem } from '@tm/shared';
import { auth } from '$lib/firebase/auth.svelte';

export async function postJson<T>(
  url: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const token = await auth.idToken();
  if (!token) throw new AppError('unauthenticated');
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, application/problem+json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AppError('unavailable', 'Could not reach the server — check your connection.');
  }
  if (!res.ok) {
    try {
      const err = fromProblem(await res.json());
      if (err.code !== 'internal' || res.status >= 500) throw err;
    } catch (e) {
      if (e instanceof AppError) throw e;
    }
    throw new AppError(codeForStatus(res.status));
  }
  return (res.status === 204 ? { ok: true } : await res.json()) as T;
}
