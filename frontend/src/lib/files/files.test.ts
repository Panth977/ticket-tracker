import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from './csv';
import { firstLines, formatDuration, kindOf, prettyJson, CARD_NEEDS_TEXT } from './kinds';
import { fileViewer, viewerList } from './viewer.svelte';
import type { ViewerFile } from './types';

const f = (id: string, name: string, mime = '', createdAt = 0): ViewerFile => ({
  id,
  name,
  mime,
  size: 10,
  path: `p/${id}/${name}`,
  createdAt,
});

describe('kinds (from @tm/shared fileInfo)', () => {
  it.each([
    ['a.png', 'image/png', 'image'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['song.mp3', 'audio/mpeg', 'audio'],
    ['plan.md', 'application/octet-stream', 'markdown'],
    ['plan.md', 'text/plain', 'markdown'],
    ['report.html', '', 'html'],
    ['doc.pdf', 'application/pdf', 'pdf'],
    ['data.csv', 'text/plain', 'csv'],
    ['data.json', 'application/json', 'json'],
    ['main.ts', 'video/mp2t', 'video'],
    ['main.py', '', 'code'],
    ['notes.txt', 'text/plain', 'text'],
    ['blob.bin', 'application/octet-stream', 'other'],
  ])('%s (%s) → %s', (name, mime, kind) => {
    expect(kindOf({ name, mime })).toBe(kind);
  });

  it('cards read text only for textual kinds', () => {
    expect([...CARD_NEEDS_TEXT].sort()).toEqual([
      'code',
      'csv',
      'html',
      'json',
      'markdown',
      'text',
    ]);
  });

  it('helpers', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toBe('a\nb');
    expect(firstLines('a', 5)).toBe('a');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('{bad')).toBe('{bad');
    expect(formatDuration(187)).toBe('3:07');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(NaN)).toBe('');
  });
});

describe('csv', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const t = parseCsv('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nx,y');
    expect(t.rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthen left'],
      ['x', 'y'],
    ]);
    expect(t.truncated).toBe(false);
  });
  it('detects TSV / semicolons and caps rows', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('a,b', 'x.tsv')).toBe('\t');
    const big = parseCsv(Array.from({ length: 50 }, (_, i) => `${i},x`).join('\n'), {
      maxRows: 10,
    });
    expect(big.rows).toHaveLength(10);
    expect(big.truncated).toBe(true);
  });
  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,,\n').rows).toEqual([['a', '', '']]);
  });
});

describe('viewer state', () => {
  const a = f('a', 'a.png', 'image/png', 3);
  const b = f('b', 'b.md', '', 1);
  const c = f('c', 'c.html', '', 2);

  it('prefers the ticket list (oldest first) when it holds the file', () => {
    expect(viewerList('a', [a, b, c], [a]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('falls back to the siblings for a file not listed yet', () => {
    const d = f('d', 'd.pdf');
    expect(viewerList('d', [a, b], [d, a]).map((x) => x.id)).toEqual(['d', 'a']);
  });
  it('open / close', () => {
    fileViewer.open(c, [a, b]);
    expect(fileViewer.current).toBe('c');
    expect(fileViewer.siblings.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    fileViewer.close();
    expect(fileViewer.current).toBeNull();
    expect(fileViewer.siblings).toEqual([]);
  });
});
