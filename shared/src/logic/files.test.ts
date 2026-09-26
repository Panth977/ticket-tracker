import { describe, expect, it } from 'vitest';
import {
  fileExtension,
  fileInfo,
  fileKind,
  fileViewerPath,
  formatBytes,
  HTML_SANDBOX,
  languageFor,
  mimeForName,
  normalizeMime,
} from './files.js';

describe('fileKind', () => {
  it.each([
    ['image/png', 'a.png', 'image'],
    ['image/svg+xml', 'logo.svg', 'image'],
    ['', 'photo.JPG', 'image'],
    ['video/mp4', 'demo.mp4', 'video'],
    ['application/octet-stream', 'clip.webm', 'video'],
    ['audio/mpeg', 'song.mp3', 'audio'],
    ['', 'voice.m4a', 'audio'],
    ['text/markdown', 'plan', 'markdown'],
    ['text/plain', 'PLAN.md', 'markdown'],
    ['application/octet-stream', 'notes.markdown', 'markdown'],
    ['text/html; charset=utf-8', 'report', 'html'],
    ['text/plain', 'report.html', 'html'],
    ['application/pdf', 'spec.pdf', 'pdf'],
    ['', 'spec.pdf', 'pdf'],
    ['text/plain', 'server.log', 'text'],
    ['text/plain', 'README', 'text'],
    ['text/csv', 'data', 'csv'],
    ['', 'data.tsv', 'csv'],
    ['application/json', 'x', 'json'],
    ['application/vnd.api+json', 'x', 'json'],
    ['text/plain', 'events.jsonl', 'json'],
    ['text/plain', 'main.ts', 'code'],
    ['application/octet-stream', 'Dockerfile', 'code'],
    ['application/x-sh', 'run', 'code'],
    ['application/zip', 'bundle.zip', 'other'],
    ['', 'mystery', 'other'],
  ])('%s %s → %s', (mime, name, kind) => {
    expect(fileKind(mime, name)).toBe(kind);
  });

  it('language guesses', () => {
    expect(languageFor('app.tsx')).toBe('tsx');
    expect(languageFor('x.py')).toBe('python');
    expect(languageFor('Makefile')).toBe('makefile');
    expect(languageFor('x.md')).toBe('markdown');
    expect(languageFor('x.png')).toBeNull();
    expect(fileInfo('application/x-sh', 'run').language).toBe('bash');
    expect(fileInfo('application/yaml', 'cfg').language).toBe('yaml');
  });

  it('textual kinds and served mime', () => {
    expect(fileInfo('text/plain', 'plan.md')).toEqual({
      kind: 'markdown',
      language: 'markdown',
      textual: true,
      mime: 'text/markdown',
    });
    expect(fileInfo('', 'r.html').mime).toBe('text/html');
    expect(fileInfo('image/png', 'x.png').textual).toBe(false);
    expect(fileInfo('application/octet-stream', 'x.bin').mime).toBe('application/octet-stream');
  });

  it('helpers', () => {
    expect(fileExtension('a/b/Report.Final.MD')).toBe('md');
    expect(fileExtension('.gitignore')).toBe('');
    expect(normalizeMime(' Text/HTML; charset=utf-8')).toBe('text/html');
    expect(mimeForName('x.md')).toBe('text/markdown');
    expect(mimeForName('x.unknown')).toBe('application/octet-stream');
    expect(fileViewerPath('ENG', 'ENG-42', 'f 1')).toBe('/f/ENG/ENG-42/f%201');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(HTML_SANDBOX).not.toContain('allow-same-origin');
  });
});
