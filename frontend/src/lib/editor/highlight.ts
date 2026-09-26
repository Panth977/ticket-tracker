/**
 * Syntax highlighting for code blocks (messages, the Markdown viewer, text /
 * code files). highlight.js CORE with a fixed set of languages, so the bundle
 * stays small; anything else renders as escaped plain text.
 *
 *   highlightCode('const a = 1', 'typescript') → '<span class="hljs-keyword">const</span> a = …'
 *
 * The output is ALWAYS safe to put in {@html}: highlight.js escapes the source
 * and only adds <span class="hljs-…">.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  plaintext,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

/**
 * Names used by @tm/shared fileInfo().language and by Markdown fence info
 * strings that highlight.js knows under another name (or that we fold into a
 * registered neighbour).
 */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  svelte: 'xml',
  vue: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  fish: 'bash',
  console: 'shell',
  yml: 'yaml',
  toml: 'ini',
  dotenv: 'ini',
  env: 'ini',
  md: 'markdown',
  jsonl: 'json',
  json5: 'json',
  patch: 'diff',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  sass: 'scss',
  less: 'scss',
  gql: 'graphql',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
};

/** The registered highlight.js language for a fence / file language, or null. */
export function resolveLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase().split(/[\s{]/)[0] ?? '';
  const name = ALIASES[l] ?? l;
  return hljs.getLanguage(name) ? name : null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Past this many characters we skip highlighting (it is slow and the viewer would stall). */
export const MAX_HIGHLIGHT_CHARS = 200_000;

/** Highlighted HTML for `code` (escaped plain text when the language is unknown or the code is huge). */
export function highlightCode(code: string, lang: string | null | undefined): string {
  const name = resolveLanguage(lang);
  if (!name || name === 'plaintext' || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
