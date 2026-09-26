/**
 * One error vocabulary for every door. Commands throw AppError; /api and /v1
 * both answer with RFC 9457 problem+json built from it; MCP maps it to a tool
 * error with the same `code`.
 */
import { z } from 'zod';

export const ERROR_STATUS = {
  /** 400 — the input failed validation (zod) or names things that do not exist on the board. */
  invalid: 400,
  /** 401 — no / bad / revoked credentials. */
  unauthenticated: 401,
  /** 403 — authenticated, but can() says no (or scope / board narrowing). */
  forbidden: 403,
  /** 404 — does not exist, OR exists on a board you cannot read (never leak existence). */
  not_found: 404,
  /** 409 — a state conflict: key taken, stale ifUpdatedAt, ticket not active, last admin… */
  conflict: 409,
  /** 410 — existed and is gone: expired / revoked invite, deleted ticket key. */
  gone: 410,
  /** 413 — body or attachment over the limit. */
  too_large: 413,
  /** 422 — well-formed but a business rule refuses it (stage `requires` unmet). */
  unprocessable: 422,
  /** 429 — rate limit; carries Retry-After. */
  rate_limited: 429,
  /** 500 — a bug. */
  internal: 500,
  /** 503 — a dependency (search, provider) is down; safe to retry. */
  unavailable: 503,
} as const;

export type AppErrorCode = keyof typeof ERROR_STATUS;
export const APP_ERROR_CODES = Object.keys(ERROR_STATUS) as AppErrorCode[];
export const AppErrorCodeSchema = z.enum(APP_ERROR_CODES as [AppErrorCode, ...AppErrorCode[]]);

export const ERROR_TITLES: Record<AppErrorCode, string> = {
  invalid: 'Invalid request',
  unauthenticated: 'Not signed in',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Conflict',
  gone: 'Gone',
  too_large: 'Too large',
  unprocessable: 'Cannot be processed',
  rate_limited: 'Too many requests',
  internal: 'Something went wrong',
  unavailable: 'Temporarily unavailable',
};

export const PROBLEM_TYPE_BASE = 'https://taskmanager.app/problems/';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * RFC 9457 problem details, plus our `code` and free-form extension members
 * (e.g. `missing` for 422, `stageId`/`count` for a stage-removal 409,
 * `current` for a stale-update 409, `issues` for zod failures, `retryAfter`).
 */
export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: AppErrorCodeSchema,
  })
  .passthrough();
export type Problem = z.infer<typeof ProblemSchema> & Record<string, unknown>;

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: AppErrorCode;
  /** Extension members merged into the problem body. Must be safe to show the caller. */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AppErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERROR_TITLES[code]);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toProblem(instance?: string): Problem {
    return toProblem(this, instance);
  }
}

export const isAppError = (e: unknown): e is AppError =>
  e instanceof AppError ||
  (typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'AppError' &&
    'code' in e);

/** Shorthands: `throw errors.forbidden('Only admins can invite')`. */
export const errors = Object.fromEntries(
  APP_ERROR_CODES.map((c) => [
    c,
    (message?: string, details?: Record<string, unknown>) => new AppError(c, message, details),
  ]),
) as { [C in AppErrorCode]: (message?: string, details?: Record<string, unknown>) => AppError };

/** Build the problem body for any AppError. Unknown errors should be mapped to `internal` by the caller. */
export function toProblem(err: AppError, instance?: string): Problem {
  const p: Problem = {
    ...(err.details ?? {}),
    type: PROBLEM_TYPE_BASE + err.code,
    title: ERROR_TITLES[err.code],
    status: ERROR_STATUS[err.code],
    code: err.code,
  };
  if (err.message && err.message !== ERROR_TITLES[err.code]) p.detail = err.message;
  if (instance) p.instance = instance;
  return p;
}

/** Turn a problem body (client side) back into an AppError. */
export function fromProblem(p: unknown): AppError {
  const parsed = ProblemSchema.safeParse(p);
  if (!parsed.success) return new AppError('internal');
  const { type: _t, title: _ti, status: _s, detail, instance: _i, code, ...rest } = parsed.data;
  return new AppError(code, detail, Object.keys(rest).length ? rest : undefined);
}

/** Map an HTTP status to our code (for responses without a problem body). */
export function codeForStatus(status: number): AppErrorCode {
  const hit = APP_ERROR_CODES.find((c) => ERROR_STATUS[c] === status);
  if (hit) return hit;
  return status >= 500 ? 'internal' : 'invalid';
}
