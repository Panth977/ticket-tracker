import { describe, expect, it } from 'vitest';
import { backendFiles, backendProblems, BACKEND_API, frontendFiles, hasBackend, withBackend } from './project';

describe('one tree', () => {
  const tree = { '/index.ts': 'f', '/backend/main.ts': 'b', '/backend/lib/a.ts': 'c', [BACKEND_API]: 'api' };

  it('splits by the /backend folder', () => {
    expect(frontendFiles(tree)).toEqual({ '/index.ts': 'f' });
    expect(backendFiles(tree)).toEqual([
      { path: 'main.ts', content: 'b' },
      { path: 'lib/a.ts', content: 'c' },
    ]);
    expect(hasBackend(tree)).toBe(true);
    expect(hasBackend({ '/index.ts': 'f' })).toBe(false);
  });

  it('the live backend wins over a copy in a source zip', () => {
    const out = withBackend({ '/web/a.js': 'x', '/backend/main.ts': 'old', '/backend/gone.ts': 'old' }, [
      { path: 'main.ts', content: 'live' },
    ]);
    expect(out['/backend/main.ts']).toBe('live');
    expect(out['/backend/gone.ts']).toBeUndefined();
    expect(out['/web/a.js']).toBe('x');
  });

  it('a zip with a backend and nothing live still shows it', () => {
    expect(withBackend({ '/backend/main.ts': 'z' })[BACKEND_API]).toBeTruthy();
    expect(withBackend({ '/a.js': 'x' })).toEqual({ '/a.js': 'x' });
  });

  it('worker problems land on tree paths', () => {
    const [d] = backendProblems([{ file: 'main.ts', line: 2, message: 'x', severity: 'error', source: 'typecheck' }]);
    expect(d!.file).toBe('/backend/main.ts');
  });
});
