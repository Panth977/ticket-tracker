/**
 * GitHub-flavoured Markdown → SAFE HTML, for agent messages (Message.markdown)
 * and Markdown files (agents.html §H, §I). ONE renderer, shared by the thread,
 * the file cards and the Markdown viewer, so a plan looks the same everywhere.
 *
 *   const { html, headings } = renderMarkdown(src, { ticketHref, anchors: true });
 *   <div class="tm-prose tm-md">{@html html}</div>
 *
 * Safety, in two layers:
 *  1. markdown-it runs with `html: false`: raw HTML in the source is shown as
 *     text, never parsed. The only HTML we emit ourselves is the task-list
 *     checkbox and the code-block copy button.
 *  2. The output then goes through DOMPurify with a tag / attribute allow-list:
 *     no style, no event handlers, no iframes / forms / scripts; links only
 *     http(s) / mailto / in-page / app paths; images only http(s) and inline
 *     raster data: URIs. External links open in a new tab with
 *     rel="noopener noreferrer nofollow"; images load lazily without a referrer.
 *
 * What GFM gets us: tables (alignment as classes), ~~strike~~, autolinks, task
 * lists, fenced code with syntax highlighting + a Copy button. Mentions written
 * the way the doors serialise them — [@Name](mailto:…) and [@Name](agent:ag_…)
 * — render as mention chips; '#ENG-42' becomes a ticket link when a
 * `ticketHref` is given.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';
import { escapeHtml, highlightCode, resolveLanguage } from './highlight';

export interface MarkdownHeading {
  level: number;
  text: string;
  /** Element id (only set when rendered with `anchors: true`). */
  id: string;
}

export interface MarkdownOptions {
  /** '#ENG-42' → this href (app path). Absent: refs stay text. */
  ticketHref?: (key: string) => string;
  /** Give headings ids (`md-<slug>`) for a table of contents. Off in the thread (ids would repeat). */
  anchors?: boolean;
  /**
   * Single newlines become <br> — how GitHub renders comments. Documents
   * (.md files) use the CommonMark default (off).
   */
  breaks?: boolean;
}

export interface RenderedMarkdown {
  html: string;
  headings: MarkdownHeading[];
}

const TICKET_KEY_RE =
  /(^|[^A-Za-z0-9_/#&-])#([A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]*)(?![A-Za-z0-9_-])/g;

interface Env {
  opts: MarkdownOptions;
  headings: MarkdownHeading[];
  slugs: Map<string, number>;
}

/** 'Step 2: Ship it!' → 'step-2-ship-it' (unique within one document). */
export function slugify(text: string, seen?: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64) || 'section';
  if (!seen) return base;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

const inlineText = (t: Token | undefined): string =>
  (t?.children ?? [])
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');

// ───────────────────────── core rules ─────────────────────────

/** Headings: collect them (for the TOC) and give them ids when anchors are on. */
function headingsRule(state: StateCore) {
  const env = state.env as Env;
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.type !== 'heading_open') continue;
    const text = inlineText(toks[i + 1]).trim();
    const level = Number(t.tag.slice(1));
    const id = env.opts.anchors ? `md-${slugify(text, env.slugs)}` : '';
    if (id) t.attrSet('id', id);
    env.headings.push({ level, text, id });
  }
}

/** GFM task lists: '- [ ] todo' / '- [x] done' → a disabled checkbox. */
function taskListRule(state: StateCore) {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const inline = toks[i]!;
    if (
      inline.type !== 'inline' ||
      toks[i - 1]!.type !== 'paragraph_open' ||
      toks[i - 2]!.type !== 'list_item_open'
    )
      continue;
    const m = /^\[([ xX])\][ \t]/.exec(inline.content);
    const first = inline.children?.[0];
    if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
    const checked = m[1] !== ' ';
    first.content = first.content.slice(m[0].length);
    inline.content = inline.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Done' : 'To do'}"> `;
    inline.children!.unshift(box);
    const li = toks[i - 2]!;
    li.attrJoin('class', 'task-list-item');
    if (checked) li.attrSet('data-checked', 'true');
    // The enclosing list (one level up).
    for (let j = i - 3; j >= 0; j--) {
      const p = toks[j]!;
      if (
        (p.type === 'bullet_list_open' || p.type === 'ordered_list_open') &&
        p.level === li.level - 1
      ) {
        if (!(p.attrGet('class') ?? '').includes('contains-task-list'))
          p.attrJoin('class', 'contains-task-list');
        break;
      }
    }
  }
}

/**
 * Links: mentions become chips ([@Name](agent:…) is not a URL at all, so it
 * turns into a <span>), '#KEY' in plain text becomes a ticket link, table
 * alignment becomes a class (we never allow style attributes).
 */
function inlineRule(state: StateCore) {
  const env = state.env as Env;
  for (const blk of state.tokens) {
    if ((blk.type === 'th_open' || blk.type === 'td_open') && blk.attrGet('style')) {
      const align = /text-align:\s*(left|center|right)/.exec(blk.attrGet('style') ?? '')?.[1];
      blk.attrs = (blk.attrs ?? []).filter(([k]) => k !== 'style');
      if (align) blk.attrJoin('class', `md-align-${align}`);
    }
    if (blk.type !== 'inline' || !blk.children) continue;
    const out: Token[] = [];
    const spanStack: boolean[] = [];
    let inLink = 0;
    const kids = blk.children;
    for (let i = 0; i < kids.length; i++) {
      const t = kids[i]!;
      if (t.type === 'link_open') {
        inLink++;
        const href = t.attrGet('href') ?? '';
        const label = kids[i + 1]?.type === 'text' ? kids[i + 1]!.content : '';
        const isAgent = href.startsWith('agent:');
        if (isAgent) {
          t.tag = 'span';
          t.attrs = [['class', 'mention']];
        } else if (href.startsWith('mailto:') && label.startsWith('@')) {
          t.attrJoin('class', 'mention');
        }
        spanStack.push(isAgent);
        out.push(t);
        continue;
      }
      if (t.type === 'link_close') {
        inLink = Math.max(0, inLink - 1);
        if (spanStack.pop()) t.tag = 'span';
        out.push(t);
        continue;
      }
      if (t.type === 'text' && !inLink && env.opts.ticketHref && t.content.includes('#')) {
        let last = 0;
        const text = t.content;
        for (const m of text.matchAll(TICKET_KEY_RE)) {
          const start = m.index! + m[1]!.length;
          if (start > last) out.push(textToken(state, text.slice(last, start)));
          const key = m[2]!.toUpperCase();
          const open = new state.Token('link_open', 'a', 1);
          open.attrs = [
            ['href', env.opts.ticketHref(key)],
            ['class', 'ticket-ref'],
          ];
          out.push(open, textToken(state, `#${key}`), new state.Token('link_close', 'a', -1));
          last = m.index! + m[0].length;
        }
        if (last === 0) out.push(t);
        else if (last < text.length) out.push(textToken(state, text.slice(last)));
        continue;
      }
      out.push(t);
    }
    blk.children = out;
  }
}

function textToken(state: StateCore, content: string): Token {
  const t = new state.Token('text', '', 0);
  t.content = content;
  return t;
}

// ───────────────────────── the parser ─────────────────────────

function makeParser(breaks: boolean): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks });
  // Agent mentions use a private scheme; everything else keeps markdown-it's checks.
  const validate = md.validateLink.bind(md);
  md.validateLink = (url: string) => /^agent:ag_[A-Za-z0-9]{16}$/.test(url) || validate(url);
  md.core.ruler.push('tm_headings', headingsRule);
  md.core.ruler.push('tm_tasks', taskListRule);
  md.core.ruler.push('tm_inline', inlineRule);
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx]!;
    const info = t.info.trim().split(/\s+/)[0] ?? '';
    const lang = resolveLanguage(info);
    const label = info ? escapeHtml(info.slice(0, 24)) : '';
    return (
      `<div class="md-code" data-lang="${label}">` +
      `<button type="button" class="md-copy" data-copy="">Copy</button>` +
      `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${highlightCode(t.content, info)}</code></pre></div>\n`
    );
  };
  md.renderer.rules.code_block = (tokens, idx) =>
    `<div class="md-code"><button type="button" class="md-copy" data-copy="">Copy</button><pre><code class="hljs">${escapeHtml(tokens[idx]!.content)}</code></pre></div>\n`;
  return md;
}

let parsers: Record<'doc' | 'comment', MarkdownIt> | null = null;
const parser = (breaks: boolean) => {
  parsers ??= { doc: makeParser(false), comment: makeParser(true) };
  return breaks ? parsers.comment : parsers.doc;
};

// ───────────────────────── sanitiser ─────────────────────────

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'button',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];
const ALLOWED_ATTR = [
  'href',
  'title',
  'alt',
  'src',
  'class',
  'id',
  'start',
  'type',
  'checked',
  'disabled',
  'aria-label',
  'colspan',
  'rowspan',
  'data-copy',
  'data-lang',
  'data-checked',
  'width',
  'height',
];
/** Links: web, mail, in-page anchors and app paths. */
const SAFE_HREF = /^(?:https?:|mailto:|#|\/(?!\/))/i;
/** Images: web, or an inline raster (never data:image/svg+xml — an <img> can't run it, but no need to allow it). */
const SAFE_SRC = /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i;

let purifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (purifier) return purifier;
  // A private instance: our hooks never leak into anyone else's DOMPurify use.
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    switch (el.tagName) {
      case 'A': {
        const href = el.getAttribute('href');
        if (href !== null && !SAFE_HREF.test(href.trim())) el.removeAttribute('href');
        const h = el.getAttribute('href') ?? '';
        if (/^(?:https?:|mailto:)/i.test(h)) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer nofollow');
        }
        break;
      }
      case 'IMG': {
        const src = el.getAttribute('src') ?? '';
        if (!SAFE_SRC.test(src.trim())) el.removeAttribute('src');
        el.setAttribute('loading', 'lazy');
        el.setAttribute('referrerpolicy', 'no-referrer');
        el.setAttribute('decoding', 'async');
        break;
      }
      case 'INPUT':
        // Only the read-only task-list checkbox survives.
        if (el.getAttribute('type') !== 'checkbox') el.remove();
        else el.setAttribute('disabled', '');
        break;
      case 'BUTTON':
        // Only our Copy button (no form behaviour, ever).
        el.setAttribute('type', 'button');
        break;
    }
  });
  purifier = p;
  return p;
}

/** Sanitise HTML that came out of renderMarkdown (exported for tests and for any other trusted-shape HTML). */
export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [...ALLOWED_ATTR, 'target', 'rel', 'loading', 'referrerpolicy', 'decoding'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // target / rel / loading are set by our hook, after the URI checks.
    ADD_ATTR: ['target'],
    FORBID_TAGS: [
      'style',
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'svg',
      'math',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: ['style'],
  }) as unknown as string;
}

/** Markdown source → sanitised HTML + its headings. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): RenderedMarkdown {
  const env: Env = { opts, headings: [], slugs: new Map() };
  const raw = parser(opts.breaks ?? false).render(src ?? '', env);
  return { html: sanitizeHtml(raw), headings: env.headings };
}

// ───────────────────────── helpers for cards / collapse ─────────────────────────

/** The first heading's text, or null — a Markdown file card's title. */
export function markdownTitle(src: string): string | null {
  for (const line of src.split('\n', 60)) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1]!.replace(/[*_`]/g, '').trim() || null;
  }
  return null;
}

/**
 * The first `lines` lines of a Markdown document for a card excerpt (a fence
 * cut in half is closed so the rest doesn't render as code).
 */
export function markdownExcerpt(src: string, lines = 12): string {
  const all = src.replace(/\r\n?/g, '\n').split('\n');
  const head = all.slice(0, lines);
  const fences = head.filter((l) => /^\s{0,3}(```|~~~)/.test(l)).length;
  if (fences % 2 === 1) head.push('```');
  return head.join('\n');
}

/** Line count of a source (collapse long messages: agents.html §H, over ~40 lines). */
export const lineCount = (src: string): number => (src ? src.split('\n').length : 0);
