import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_STATUS,
  errors,
  fromProblem,
  isAppError,
  ProblemSchema,
  codeForStatus,
} from './errors.js';

describe('errors', () => {
  it('maps codes to HTTP statuses', () => {
    expect(ERROR_STATUS.unauthenticated).toBe(401);
    expect(ERROR_STATUS.forbidden).toBe(403);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.conflict).toBe(409);
    expect(ERROR_STATUS.gone).toBe(410);
    expect(ERROR_STATUS.unprocessable).toBe(422);
    expect(ERROR_STATUS.rate_limited).toBe(429);
    expect(codeForStatus(422)).toBe('unprocessable');
    expect(codeForStatus(418)).toBe('invalid');
    expect(codeForStatus(502)).toBe('internal');
  });

  it('builds RFC 9457 problem+json with extensions, and round-trips', () => {
    const e = errors.unprocessable('Fill in Solution first', { missing: ['f_soluti'] });
    expect(e).toBeInstanceOf(AppError);
    expect(isAppError(e)).toBe(true);
    expect(e.status).toBe(422);
    const p = e.toProblem('/api/ticketUpdate');
    expect(ProblemSchema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({
      type: 'https://taskmanager.app/problems/unprocessable',
      status: 422,
      code: 'unprocessable',
      detail: 'Fill in Solution first',
      instance: '/api/ticketUpdate',
      missing: ['f_soluti'],
    });
    const back = fromProblem(JSON.parse(JSON.stringify(p)));
    expect(back.code).toBe('unprocessable');
    expect(back.details).toEqual({ missing: ['f_soluti'] });
    expect(fromProblem({ nope: true }).code).toBe('internal');
  });

  it('extension members cannot override the standard ones', () => {
    const p = new AppError('forbidden', undefined, { status: 200, code: 'x' }).toProblem();
    expect(p.status).toBe(403);
    expect(p.code).toBe('forbidden');
    expect(p.detail).toBeUndefined();
  });
});
