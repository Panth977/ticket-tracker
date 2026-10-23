import { describe, expect, it } from 'vitest';
import { compile } from '@panth977/sandbox/compiler';
import { KIT_TEMPLATES } from './templates';

describe('Code tab starters', () => {
  it('offers plain JavaScript, TypeScript, React and Svelte', () => {
    expect(KIT_TEMPLATES.map((t) => t.label)).toEqual(['JavaScript', 'TypeScript', 'React', 'Svelte']);
  });
  it('the JavaScript starter is plain JS that builds without TypeScript', async () => {
    const js = KIT_TEMPLATES.find((t) => t.id === 'javascript')!;
    const src = js.files['/index.js'];
    expect(src).not.toMatch(/\)!|as any|: Date|as HTML|err: any/);
    const r = await compile(js.files);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
