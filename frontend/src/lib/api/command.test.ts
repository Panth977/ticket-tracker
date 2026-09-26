import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, PROBLEM_CONTENT_TYPE } from '@tm/shared';
import { _resetOverlays, applyOverlays } from '$lib/stores/overlay';
import { createCommandClient, type CommandDeps } from './command';

afterEach(() => {
  _resetOverlays();
  vi.useRealTimers();
});

function deps(over: Partial<CommandDeps> = {}) {
  const d = {
    getToken: vi.fn(async () => 'tok'),
    fetch: vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch,
    isOnline: () => true,
    toastError: vi.fn(),
    onSaving: vi.fn(),
    ...over,
  } satisfies CommandDeps;
  return d;
}

const problem = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': PROBLEM_CONTENT_TYPE } });

describe('command()', () => {
  it('POSTs to /api/{name} with token and clientId, returns the parsed response', async () => {
    const d = deps();
    const command = createCommandClient(d);
    const res = await command('profileUpdate', { name: 'Ok' });
    expect(res).toEqual({ ok: true });
    const [url, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/profileUpdate');
    expect(init.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('maps problem+json to a typed AppError, toasts, and rolls back', async () => {
    const d = deps({
      fetch: vi.fn(async () =>
        problem(409, {
          type: 'x',
          title: 'Conflict',
          status: 409,
          code: 'conflict',
          detail: 'Key taken',
          current: 1,
        }),
      ) as unknown as typeof fetch,
    });
    const command = createCommandClient(d);
    const p = command(
      'profileUpdate',
      { name: 'New' },
      { optimistic: { path: 'users/u1', patch: { name: 'New' } } },
    );
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'New' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('conflict');
    expect((err as AppError).message).toBe('Key taken');
    expect((err as AppError).details).toEqual({ current: 1 });
    expect(d.toastError).toHaveBeenCalledWith('Key taken', undefined);
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'Old' });
  });

  it('rejects invalid input before sending', async () => {
    const d = deps();
    const command = createCommandClient(d);
    const err = await command('profileUpdate', { name: '' }, { toast: false }).catch(
      (e: unknown) => e,
    );
    expect((err as AppError).code).toBe('invalid');
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.toastError).not.toHaveBeenCalled();
  });

  it('refuses offline without a request', async () => {
    const d = deps({ isOnline: () => false });
    const err = await createCommandClient(d)('profileUpdate', { name: 'x' }).catch(
      (e: unknown) => e,
    );
    expect((err as AppError).code).toBe('unavailable');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("shows 'Saving…' only after 250 ms", async () => {
    vi.useFakeTimers();
    let resolve!: (r: Response) => void;
    const d = deps({
      fetch: vi.fn(() => new Promise<Response>((r) => (resolve = r))) as unknown as typeof fetch,
    });
    const p = createCommandClient(d)('profileUpdate', { name: 'x' });
    await vi.advanceTimersByTimeAsync(100);
    expect(d.onSaving).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(d.onSaving).toHaveBeenCalledWith(1);
    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await p;
    expect(d.onSaving).toHaveBeenLastCalledWith(-1);
  });

  it('retries once with a refreshed token on 401, same clientId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        problem(401, { type: 'x', title: 't', status: 401, code: 'unauthenticated' }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const d = deps({ fetch: fetchMock as unknown as typeof fetch });
    await createCommandClient(d)('profileUpdate', { name: 'x' });
    expect(d.getToken).toHaveBeenLastCalledWith(true);
    const ids = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).clientId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('non-problem 5xx becomes internal/unavailable by status', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch,
    });
    const err = await createCommandClient(d)('profileUpdate', { name: 'x' }).catch(
      (e: unknown) => e,
    );
    expect((err as AppError).code).toBe('unavailable');
  });
});
