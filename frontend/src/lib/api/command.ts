/**
 * command(name, input, opts) — the ONLY way the app writes (docs/plan
 * architecture › Writes): POST /api/{name} with the Firebase ID token and a
 * clientId (idempotency: a retried request is one change).
 *
 *   const { ticketId, key } = await command('ticketCreate', { boardId, title });
 *   await command('ticketUpdate', { ticketId, patch }, {
 *     optimistic: { path: paths.ticket(boardId, ticketId), patch: { title } },
 *   });
 *
 * Typed end to end from @tm/shared COMMANDS: the input is CommandReq<N>, the
 * result CommandRes<N>. A refusal (problem+json) throws a typed AppError
 * ({ code, message, details }) after rolling back the optimistic patch and
 * showing a toast (pass `toast: false` to handle it yourself). If a request
 * takes longer than 250 ms the shell shows 'Saving…'.
 * Offline, commands are refused at once — writes are never queued.
 */
import {
  AppError,
  COMMANDS,
  codeForStatus,
  fromProblem,
  isAppError,
  type CommandName,
  type CommandReq,
  type CommandRes,
} from '@tm/shared';
import { patchDoc, type Patch } from '$lib/stores/overlay';

export type OptimisticSpec =
  | { path: string; patch: Patch }
  | { path: string; patch: Patch }[]
  /** Apply anything; return the rollback. */
  | (() => () => void);

export interface CommandOptions {
  optimistic?: OptimisticSpec;
  /** Reuse to make a retry idempotent; generated otherwise. */
  clientId?: string;
  /** false = no toast on failure; a string = the toast's headline. */
  toast?: boolean | string;
  signal?: AbortSignal;
}

/** Input without clientId (pass it via opts.clientId). */
// Distributive: a union request (whatsappLink send | verify) keeps its variants
// instead of collapsing to their common keys.
export type CommandInput<N extends CommandName> =
  CommandReq<N> extends infer T ? (T extends unknown ? Omit<T, 'clientId'> : never) : never;

export interface CommandDeps {
  getToken(forceRefresh?: boolean): Promise<string | null>;
  fetch: typeof fetch;
  isOnline(): boolean;
  toastError(message: string, detail?: string): void;
  /** Saving indicator: called with +1 when a request crosses the delay, -1 when it ends. */
  onSaving(delta: 1 | -1): void;
  baseUrl?: string;
  savingDelayMs?: number;
}

/** How long a successful optimistic patch outlives the response. */
export const OVERLAY_SETTLE_MS = 1500;

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function applyOptimistic(spec: OptimisticSpec | undefined): () => void {
  if (!spec) return () => {};
  if (typeof spec === 'function') return spec();
  const list = Array.isArray(spec) ? spec : [spec];
  const undos = list.map((s) => patchDoc(s.path, s.patch));
  return () => undos.forEach((u) => u());
}

/** A failed command's problem, turned back into an AppError. */
async function errorFrom(res: Response): Promise<AppError> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      const body: unknown = await res.json();
      const err = fromProblem(body);
      if (err.code !== 'internal' || res.status >= 500) return err;
    } catch {
      /* fall through */
    }
  }
  return new AppError(codeForStatus(res.status));
}

/** Human text for a toast. */
export function describeError(err: AppError): string {
  switch (err.code) {
    case 'unavailable':
      return err.message || 'The service is unavailable — try again.';
    case 'rate_limited':
      return 'Too many requests — wait a moment and try again.';
    default:
      return err.message;
  }
}

export function createCommandClient(deps: CommandDeps) {
  const base = deps.baseUrl ?? '/api';
  const delay = deps.savingDelayMs ?? 250;

  async function send(name: string, body: unknown, token: string | null, signal?: AbortSignal) {
    return deps.fetch(`${base}/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, application/problem+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  return async function command<N extends CommandName>(
    name: N,
    input: CommandInput<N>,
    opts: CommandOptions = {},
  ): Promise<CommandRes<N>> {
    const spec = COMMANDS[name];
    const clientId = opts.clientId ?? newClientId();
    const body = { ...(input as object), clientId };
    let rollback: () => void = () => {};
    let savingShown = false;
    const timer = setTimeout(() => {
      savingShown = true;
      deps.onSaving(1);
    }, delay);

    try {
      if (!deps.isOnline())
        throw new AppError('unavailable', "You're offline — changes can't be saved right now.");
      // Validate before sending: a bad input is a bug on this side, caught early.
      const check = spec.req.safeParse(body);
      if (!check.success) {
        throw new AppError('invalid', check.error.issues[0]?.message ?? 'Invalid input', {
          issues: check.error.issues,
        });
      }
      rollback = applyOptimistic(opts.optimistic);

      let token = await deps.getToken();
      if (!token) throw new AppError('unauthenticated');
      let res: Response;
      try {
        res = await send(name, body, token, opts.signal);
        if (res.status === 401) {
          // Token may have just expired: refresh once, same clientId.
          token = await deps.getToken(true);
          res = await send(name, body, token, opts.signal);
        }
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') throw e;
        throw new AppError('unavailable', 'Could not reach the server — check your connection.');
      }
      if (!res.ok) throw await errorFrom(res);
      const json: unknown = res.status === 204 ? { ok: true } : await res.json();
      const parsed = spec.res.safeParse(json);
      if (!parsed.success) {
        console.warn(`[command] ${name}: response did not match its contract`, parsed.error.issues);
        return json as CommandRes<N>;
      }
      return parsed.data as CommandRes<N>;
    } catch (e) {
      rollback();
      const err = isAppError(e)
        ? e
        : (e as { name?: string })?.name === 'AbortError'
          ? null
          : new AppError('internal', e instanceof Error ? e.message : undefined);
      if (!err) throw e;
      if (opts.toast !== false) {
        const headline = typeof opts.toast === 'string' ? opts.toast : describeError(err);
        deps.toastError(headline, typeof opts.toast === 'string' ? describeError(err) : undefined);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (savingShown) deps.onSaving(-1);
      // On success the listener delivers the committed document shortly after
      // the response; keep the overlay a moment longer so the UI never flickers
      // back to the old value. (After a failure it is already rolled back.)
      setTimeout(rollback, OVERLAY_SETTLE_MS);
    }
  };
}
