/**
 * A file's ICON and its TINT, by extension first and kind second — so a tree
 * of files reads at a glance (memory.html §F): Markdown, TypeScript, JSON,
 * a spreadsheet, an APK and a video each look different, as in an editor's
 * explorer. KIND_ICON (kinds.ts) stays the coarse per-kind answer.
 */
import {
  BookOpenText,
  Database,
  File,
  FileArchive,
  FileAxis3d,
  FileBox,
  FileBraces,
  FileChartColumn,
  FileCode,
  FileCog,
  FileDigit,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  Globe,
  Presentation,
  Smartphone,
} from 'lucide-svelte';
import { infoOf } from './kinds';
import type { IconComponent } from '$lib/ui/types';

export interface FileIcon {
  icon: IconComponent;
  /** A text-colour class for the icon. */
  tone: string;
}

const T = {
  md: 'text-sky-500',
  ts: 'text-blue-500',
  js: 'text-yellow-500',
  py: 'text-emerald-500',
  web: 'text-orange-500',
  style: 'text-pink-500',
  data: 'text-amber-500',
  sheet: 'text-green-600',
  doc: 'text-blue-600',
  slides: 'text-orange-600',
  pdf: 'text-red-500',
  image: 'text-violet-500',
  video: 'text-rose-500',
  audio: 'text-fuchsia-500',
  archive: 'text-yellow-600',
  app: 'text-lime-600',
  shell: 'text-slate-400',
  config: 'text-slate-500',
  secret: 'text-red-600',
  db: 'text-cyan-600',
  three: 'text-teal-500',
  other: 'text-muted',
} as const;

const BY_EXT: Record<string, FileIcon> = {};
const put = (exts: string, icon: IconComponent, tone: string) => {
  for (const e of exts.split(' ')) BY_EXT[e] = { icon, tone };
};
put('md mdx markdown', BookOpenText, T.md);
put('txt rtf log', FileText, T.other);
put('ts tsx mts cts', FileCode, T.ts);
put('js jsx mjs cjs', FileCode, T.js);
put('py', FileCode, T.py);
put('go rs java kt swift c h cpp hpp cs rb php dart scala lua r', FileCode, T.ts);
put('svelte vue astro', FileCode, T.web);
put('html htm', Globe, T.web);
put('css scss sass less', FileCode, T.style);
put('json jsonc json5 geojson', FileBraces, T.data);
put('yaml yml toml ini env conf cfg properties', FileCog, T.config);
put('xml plist', FileCode, T.data);
put('csv tsv', FileSpreadsheet, T.sheet);
put('xls xlsx ods numbers', FileSpreadsheet, T.sheet);
put('doc docx odt pages', FileText, T.doc);
put('ppt pptx odp key', Presentation, T.slides);
put('pdf', FileType, T.pdf);
put('png jpg jpeg gif webp avif heic bmp ico tif tiff svg', FileImage, T.image);
put('mp4 mov m4v webm mkv avi wmv', FileVideoCamera, T.video);
put('mp3 wav ogg oga flac m4a aac opus', FileMusic, T.audio);
put('zip gz tgz tar rar 7z bz2 xz zst', FileArchive, T.archive);
put('apk aab ipa', Smartphone, T.app);
put('exe msi dmg pkg deb rpm appimage', FileBox, T.app);
put('sh bash zsh fish ps1 bat cmd', FileTerminal, T.shell);
put('pem key crt cer p12 pfx', FileKey, T.secret);
put('lock', FileLock, T.config);
put('sql sqlite db', Database, T.db);
put('obj fbx glb gltf stl blend', FileAxis3d, T.three);
put('bin dat wasm', FileDigit, T.other);
put('ipynb', FileChartColumn, T.py);

/** Names that mean something regardless of extension. */
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: { icon: FileCog, tone: T.config },
  makefile: { icon: FileTerminal, tone: T.shell },
  license: { icon: FileText, tone: T.other },
  'package.json': { icon: FileBraces, tone: T.app },
  '.gitignore': { icon: FileCog, tone: T.config },
  '.env': { icon: FileKey, tone: T.secret },
};

const BY_KIND: Record<string, FileIcon> = {
  image: { icon: FileImage, tone: T.image },
  video: { icon: FileVideoCamera, tone: T.video },
  audio: { icon: FileMusic, tone: T.audio },
  markdown: { icon: BookOpenText, tone: T.md },
  html: { icon: Globe, tone: T.web },
  pdf: { icon: FileType, tone: T.pdf },
  csv: { icon: FileSpreadsheet, tone: T.sheet },
  json: { icon: FileBraces, tone: T.data },
  code: { icon: FileCode, tone: T.ts },
  text: { icon: FileText, tone: T.other },
};

export function fileIcon(f: { name: string; mime?: string | null }): FileIcon {
  const lower = f.name.toLowerCase();
  const named = BY_NAME[lower];
  if (named) return named;
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const kind = infoOf({ name: f.name, mime: f.mime ?? '' }).kind;
  return BY_KIND[kind] ?? { icon: File, tone: T.other };
}
