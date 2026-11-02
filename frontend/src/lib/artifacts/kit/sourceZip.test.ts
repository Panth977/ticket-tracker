import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { firstSourceFile, readSourceZip } from './sourceZip';

describe('readSourceZip', () => {
  it('keeps text source, leaves out dependencies, output and binaries', () => {
    const zip = zipSync({
      'src/main.ts': strToU8('console.log(1)'),
      'package.json': strToU8('{}'),
      'node_modules/a/index.js': strToU8('x'),
      'dist/app.js': strToU8('x'),
      'package-lock.json': strToU8('{}'),
      'logo.png': new Uint8Array([137, 80, 0, 71]),
    });
    const r = readSourceZip(zip);
    expect(Object.keys(r.files).sort()).toEqual(['/package.json', '/src/main.ts']);
    expect(r.files['/src/main.ts']).toBe('console.log(1)');
    expect(r.skipped).toBe(1);
  });

  it('skips what is not UTF-8', () => {
    expect(readSourceZip(zipSync({ 'a.txt': new Uint8Array([0xff, 0xfe, 0x41]) })).skipped).toBe(1);
  });
});

describe('firstSourceFile', () => {
  it('prefers the entry', () => {
    expect(firstSourceFile({ '/a.css': '', '/src/main.tsx': '', '/index.html': '' })).toBe('/src/main.tsx');
    expect(firstSourceFile({ '/a.css': '', '/README.md': '' })).toBe('/README.md');
  });
});
