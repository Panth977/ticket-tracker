/**
 * The web side of file kinds (agents.html §I). Detection itself is
 * @tm/shared fileInfo() — ONE answer shared with the REST / MCP doors — and
 * this adds what only the UI needs: icons, labels, and which kinds need the
 * file's text to draw a card or a viewer.
 */
import {
  Braces,
  File,
  FileCode2,
  FileImage,
  FileText,
  FileType2,
  Film,
  Globe,
  Music,
  Sheet,
} from 'lucide-svelte';
import { fileInfo, type FileInfo, type FileKind } from '@tm/shared';
import type { ViewerFile } from './types';

export type { FileKind, FileInfo };

export const infoOf = (f: Pick<ViewerFile, 'mime' | 'name'>): FileInfo => fileInfo(f.mime, f.name);
export const kindOf = (f: Pick<ViewerFile, 'mime' | 'name'>): FileKind => infoOf(f).kind;

export const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  markdown: 'Markdown',
  html: 'HTML',
  pdf: 'PDF',
  text: 'Text',
  csv: 'CSV',
  json: 'JSON',
  code: 'Code',
  other: 'File',
};

export const KIND_ICON = {
  image: FileImage,
  video: Film,
  audio: Music,
  markdown: FileText,
  html: Globe,
  pdf: FileType2,
  text: FileText,
  csv: Sheet,
  json: Braces,
  code: FileCode2,
  other: File,
} satisfies Record<FileKind, unknown>;

/** Kinds whose CARD shows content read from the file (so it is fetched lazily when on screen). */
export const CARD_NEEDS_TEXT: ReadonlySet<FileKind> = new Set<FileKind>([
  'markdown',
  'html',
  'text',
  'csv',
  'json',
  'code',
]);

/** Bytes read for a card's excerpt / preview. HTML needs the whole document to render. */
export const CARD_TEXT_BYTES = 64 * 1024;
export const CARD_HTML_BYTES = 2 * 1024 * 1024;
/** Bytes read for the viewer (bigger text files show truncated, with Download for the rest). */
export const VIEWER_TEXT_BYTES = 5 * 1024 * 1024;

/** The first `n` lines of a text (for code / text / CSV card excerpts). */
export function firstLines(text: string, n: number): string {
  let i = -1;
  for (let k = 0; k < n; k++) {
    i = text.indexOf('\n', i + 1);
    if (i === -1) return text;
  }
  return text.slice(0, i);
}

/** JSON pretty-printed when it parses (a JSONL / invalid file is shown as is). */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** '3:07' / '1:02:03' — a video card's duration. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
