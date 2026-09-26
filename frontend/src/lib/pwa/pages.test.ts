import { describe, expect, it } from 'vitest';
import { staticPages } from './pages';

describe('staticPages', () => {
  const files = [
    '/integrate/index.html',
    '/integrate/claude/index.html',
    '/qa/mobile.html',
    '/offline.html',
    '/llms-full.txt',
    '/icons/icon-192.png',
  ];

  it('maps a directory index from the file, the directory and the bare path', () => {
    const pages = staticPages(files);
    for (const url of ['/integrate', '/integrate/', '/integrate/index.html'])
      expect(pages.get(url)).toBe('/integrate/index.html');
    expect(pages.get('/integrate/claude')).toBe('/integrate/claude/index.html');
  });

  it('maps a plain page to itself', () => {
    const pages = staticPages(files);
    expect(pages.get('/qa/mobile.html')).toBe('/qa/mobile.html');
    expect(pages.get('/offline.html')).toBe('/offline.html');
  });

  it('leaves SPA routes and non-HTML files alone', () => {
    const pages = staticPages(files);
    for (const url of ['/', '/inbox', '/t/ENG-4', '/llms-full.txt', '/icons/icon-192.png'])
      expect(pages.has(url)).toBe(false);
  });

  it('never claims the app root, whatever the base', () => {
    expect(staticPages(['/index.html']).has('/')).toBe(false);
    expect(staticPages(['/app/index.html'], '/app').has('/app')).toBe(false);
  });
});
