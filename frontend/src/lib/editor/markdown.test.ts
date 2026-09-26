// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  lineCount,
  markdownExcerpt,
  markdownTitle,
  renderMarkdown,
  sanitizeHtml,
  slugify,
} from './markdown';
import { highlightCode, resolveLanguage } from './highlight';

const html = (src: string, o = {}) => renderMarkdown(src, o).html;

describe('renderMarkdown — GFM', () => {
  it('renders tables with alignment as classes, never style', () => {
    const out = html('| a | b |\n|:-:|--:|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('class="md-align-center"');
    expect(out).toContain('class="md-align-right"');
    expect(out).not.toContain('style=');
  });

  it('renders task lists as disabled checkboxes', () => {
    const out = html('- [ ] todo\n- [x] done');
    expect(out).toContain('contains-task-list');
    expect(out.match(/<input[^>]*type="checkbox"/g)).toHaveLength(2);
    expect(out).toMatch(/<input[^>]*checked/);
    expect(out).toMatch(/<input[^>]*disabled/);
    expect(out).not.toContain('[x]');
  });

  it('highlights fenced code and adds a Copy button', () => {
    const out = html('```ts\nconst a: number = 1;\n```');
    expect(out).toContain('class="md-copy"');
    expect(out).toContain('data-copy');
    expect(out).toContain('hljs-keyword');
    expect(out).toContain('language-typescript');
  });

  it('strikethrough, autolinks and headings with anchors', () => {
    const r = renderMarkdown('# Plan A\n\n## Plan A\n\n~~old~~ see https://example.com', {
      anchors: true,
    });
    expect(r.html).toContain('<s>old</s>');
    expect(r.html).toContain('href="https://example.com"');
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
    expect(r.headings.map((h) => h.id)).toEqual(['md-plan-a', 'md-plan-a-1']);
    expect(r.html).toContain('id="md-plan-a-1"');
  });

  it('no heading ids without anchors (the thread)', () => {
    expect(html('# Title')).not.toContain('id=');
  });

  it('breaks: single newlines become <br> for comments only', () => {
    expect(html('a\nb', { breaks: true })).toContain('<br>');
    expect(html('a\nb')).not.toContain('<br>');
  });

  it('mentions and ticket refs', () => {
    const out = html(
      'hi [@Priya](mailto:p@x.com) and [@Builder](agent:ag_abcdefghijklmnop), see #eng-42',
      {
        ticketHref: (k: string) => `/t/${k}`,
      },
    );
    expect(out).toContain('class="mention"');
    expect(out).toMatch(/<span class="mention">@Builder<\/span>/);
    expect(out).not.toContain('agent:');
    expect(out).toContain('<a href="/t/ENG-42" class="ticket-ref">#ENG-42</a>');
    // Internal links stay in the tab.
    expect(out).not.toMatch(/ticket-ref"[^>]*target/);
  });
});

describe('sanitiser', () => {
  it('never parses raw HTML from the source', () => {
    const out = html(
      '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://evil"></iframe>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
    expect(out).not.toMatch(/<img/);
    expect(out).toContain('&lt;script&gt;');
  });

  it('drops javascript: and data: links', () => {
    const out = html('[x](javascript:alert(1)) [y](data:text/html,hi) [z](vbscript:1)');
    expect(out).not.toMatch(/href="(javascript|data|vbscript):/i);
  });

  it('keeps https images, lazy and without referrer; drops unsafe srcs', () => {
    const ok = html('![a](https://example.com/a.png)');
    expect(ok).toContain('src="https://example.com/a.png"');
    expect(ok).toContain('loading="lazy"');
    expect(ok).toContain('referrerpolicy="no-referrer"');
    const bad = html('![a](data:image/svg+xml;base64,PHN2Zz4=)');
    expect(bad).not.toMatch(/src="data:image\/svg/);
    expect(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).not.toContain('src=');
  });

  it('sanitizeHtml strips handlers, styles, forms and non-checkbox inputs', () => {
    const out = sanitizeHtml(
      '<p style="position:fixed" onclick="x()">a</p><form><input type="text"></form><input type="checkbox"><a href="javascript:x">l</a><svg><script>1</script></svg>',
    );
    expect(out).not.toMatch(/style=|onclick|<form|type="text"|javascript:|<svg|<script/);
    expect(out).toMatch(
      /<input[^>]*type="checkbox"[^>]*disabled|<input[^>]*disabled[^>]*type="checkbox"/,
    );
  });
});

describe('helpers', () => {
  it('slugify is unique per document', () => {
    const seen = new Map<string, number>();
    expect(slugify('Hello, World!', seen)).toBe('hello-world');
    expect(slugify('Hello World', seen)).toBe('hello-world-1');
    expect(slugify('***')).toBe('section');
  });
  it('title, excerpt, line count', () => {
    expect(markdownTitle('intro\n\n## The *Plan* ##\n# Later')).toBe('The Plan');
    expect(markdownTitle('no heading')).toBeNull();
    expect(markdownExcerpt('a\n```js\nx\ny', 3)).toBe('a\n```js\nx\n```');
    expect(lineCount('a\nb\nc')).toBe(3);
    expect(lineCount('')).toBe(0);
  });
  it('highlight resolves aliases and escapes unknown languages', () => {
    expect(resolveLanguage('tsx')).toBe('typescript');
    expect(resolveLanguage('nope')).toBeNull();
    expect(highlightCode('<b>', 'nope')).toBe('&lt;b&gt;');
    expect(highlightCode('<b>', 'html')).not.toContain('<b>');
  });
});
