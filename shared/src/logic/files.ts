/**
 * File kinds (docs/plan/agents.html §I) — ONE answer to "how do we open this
 * file?", shared by the web viewer (cards, lightbox, iframe), the REST / MCP
 * doors (read_file returns text for text-ish kinds) and the upload path.
 *
 *   fileKind(mime, name) → image | video | audio | markdown | html | pdf | text | csv | json | code | other
 *   fileInfo(mime, name) → { kind, language, textual, mime } (language for syntax highlighting)
 *
 * Pure and synchronous. Extension wins over a generic / wrong mime
 * ('application/octet-stream', 'text/plain' for .md), because agents upload
 * with whatever mime their HTTP client guessed.
 */
import { z } from 'zod';

export const FILE_KINDS = [
  'image',
  'video',
  'audio',
  'markdown',
  'html',
  'pdf',
  'text',
  'csv',
  'json',
  'code',
  'other',
] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKindSchema>;

/** Kinds whose content is text: read_file / GET /v1/files/{id}?content=1 return it inline. */
export const TEXTUAL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'markdown',
  'html',
  'text',
  'csv',
  'json',
  'code',
]);
export const isTextualKind = (k: FileKind): boolean => TEXTUAL_KINDS.has(k);

/** Largest text returned inline by read_file / ?content=1; above it only the signed URL. */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
/** Largest upload through the API (POST /v1/tickets/{KEY}/files, MCP upload_file). */
export const MAX_API_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Signed download URLs handed out by the API live this long. */
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/**
 * The iframe sandbox for HTML files: scripts run, popups and forms work, but
 * NEVER allow-same-origin — the document can never touch the app or the session.
 * Always load with srcdoc (or a blob URL), never the app's origin.
 */
export const HTML_SANDBOX = 'allow-scripts allow-popups allow-forms';

/** Extension → language id (highlight.js / Shiki names). */
const CODE_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  bat: 'bat',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  svelte: 'svelte',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'dotenv',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  tf: 'hcl',
  hcl: 'hcl',
  proto: 'protobuf',
  diff: 'diff',
  patch: 'diff',
  prisma: 'prisma',
  sol: 'solidity',
  zig: 'zig',
  nim: 'nim',
  ml: 'ocaml',
  fs: 'fsharp',
  elm: 'elm',
  groovy: 'groovy',
  gradle: 'groovy',
};

/** application/* mimes that are code. */
const CODE_MIMES: Record<string, string> = {
  'application/javascript': 'javascript',
  'application/x-javascript': 'javascript',
  'application/typescript': 'typescript',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/x-sh': 'bash',
  'application/sql': 'sql',
  'application/toml': 'toml',
  'application/graphql': 'graphql',
};

/** Whole file names (lower-cased) that are code without an extension. */
const CODE_FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  procfile: 'yaml',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.env': 'dotenv',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
};

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
  'heic',
  'heif',
  'tif',
  'tiff',
]);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'avi']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);
const TEXT_EXT = new Set(['txt', 'text', 'log', 'rst', 'adoc', 'tex']);
const CSV_EXT = new Set(['csv', 'tsv']);
const JSON_EXT = new Set(['json', 'jsonl', 'ndjson', 'json5', 'geojson', 'webmanifest']);

/** 'Report.Final.MD' → 'md'; 'Dockerfile' → ''. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

const baseName = (name: string) => (name.split(/[\\/]/).pop() ?? name).toLowerCase();

/** mime without parameters, lower-cased: 'text/markdown; charset=utf-8' → 'text/markdown'. */
export const normalizeMime = (mime: string | null | undefined): string =>
  (mime ?? '').split(';')[0]!.trim().toLowerCase();

export interface FileInfo {
  kind: FileKind;
  /** Syntax-highlighting language for text-ish kinds ('markdown', 'html', 'json', 'csv', 'typescript' …); null otherwise. */
  language: string | null;
  /** Content is text (see TEXTUAL_KINDS). */
  textual: boolean;
  /** Best mime to serve it with (the given one, or one derived from the extension when that was generic). */
  mime: string;
}

const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
  'text/plain',
]);

/** The mime an extension implies, for uploads that came without one (MCP upload_file { name, text }). */
export function mimeForName(name: string): string {
  const ext = fileExtension(name);
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    md: 'text/markdown',
    markdown: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    pdf: 'application/pdf',
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    ndjson: 'application/x-ndjson',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    zip: 'application/zip',
  };
  if (byExt[ext]) return byExt[ext];
  if (CODE_LANGUAGES[ext] || CODE_FILENAMES[baseName(name)]) return 'text/plain';
  return 'application/octet-stream';
}

/** Everything the viewer and the API need to know about how to open a file. */
export function fileInfo(mimeIn: string | null | undefined, name: string): FileInfo {
  const mime0 = normalizeMime(mimeIn);
  const ext = fileExtension(name);
  const base = baseName(name);
  const mime =
    GENERIC_MIMES.has(mime0) && mimeForName(name) !== 'application/octet-stream'
      ? mimeForName(name)
      : mime0 || mimeForName(name);
  const out = (kind: FileKind, language: string | null = null): FileInfo => ({
    kind,
    language,
    textual: isTextualKind(kind),
    mime,
  });

  // Extension first for the document kinds agents produce (their mime is often generic or wrong).
  if (MARKDOWN_EXT.has(ext)) return out('markdown', 'markdown');
  if (HTML_EXT.has(ext)) return out('html', 'html');
  if (ext === 'pdf') return out('pdf');
  if (CSV_EXT.has(ext)) return out('csv', 'csv');
  if (JSON_EXT.has(ext)) return out('json', 'json');

  if (mime.startsWith('image/')) return out('image');
  if (mime.startsWith('video/')) return out('video');
  if (mime.startsWith('audio/')) return out('audio');
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return out('markdown', 'markdown');
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return out('html', 'html');
  if (mime === 'application/pdf') return out('pdf');
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return out('csv', 'csv');
  if (mime === 'application/json' || mime.endsWith('+json') || mime === 'application/x-ndjson')
    return out('json', 'json');

  if (IMAGE_EXT.has(ext)) return out('image');
  if (VIDEO_EXT.has(ext)) return out('video');
  if (AUDIO_EXT.has(ext)) return out('audio');

  const lang = CODE_LANGUAGES[ext] ?? CODE_FILENAMES[base];
  if (lang) return out('code', lang);
  if (TEXT_EXT.has(ext)) return out('text', 'plaintext');
  if (mime.startsWith('text/')) return out('text', 'plaintext');
  const byMime = CODE_MIMES[mime];
  if (byMime) return out('code', byMime);
  return out('other');
}

/** The kind alone (see fileInfo). */
export const fileKind = (mime: string | null | undefined, name: string): FileKind =>
  fileInfo(mime, name).kind;

/** Syntax-highlighting language guess from a name (null when unknown). */
export const languageFor = (name: string, mime?: string | null): string | null =>
  fileInfo(mime ?? '', name).language;

/**
 * The in-app page of one file, opened in a new tab (§I): /f/{boardKey}/{ticketKey}/{fileId}.
 */
export const fileViewerPath = (boardKey: string, ticketKey: string, fileId: string): string =>
  `/f/${encodeURIComponent(boardKey)}/${encodeURIComponent(ticketKey)}/${encodeURIComponent(fileId)}`;

/** '1.4 MB' — for file cards. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
