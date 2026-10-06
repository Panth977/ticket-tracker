/**
 * Getting at a file's bytes — THROUGH THE API, never straight from Storage.
 *
 * The browser used to read attachments with getBlob() / getDownloadURL(),
 * which the Storage rules allowed by looking the board up with a cross-service
 * firestore.get(). That lookup fails in production, and a failed lookup is a
 * rule error, which is a 403: files an agent had uploaded showed "Could not
 * load this file" while avatars (rule: plain signedIn()) loaded fine from the
 * same bucket. So the backend — which already owns can(read) — hands out the
 * bytes (shared/api/files.ts, backend/platform/fileAccess.ts):
 *
 *   fileUrl(path)            a media src: a short-lived SIGNED URL in
 *                            production, the streaming route in dev
 *   fileBytesUrl(path)       same-origin URL for fetch() / Range / download
 *   fileText(file, bytes)    the first `bytes` of the file as text (cached)
 *   downloadFile(file)       save it under its own name
 *
 * Both URLs expire (15 min) and are cached per path until they do — never
 * stored. fetch() deliberately uses the SAME-ORIGIN url: a cross-origin signed
 * URL would need a bucket CORS configuration, while an <img>/<video> src does
 * not, which is why there are two.
 */
import {
  FILE_ACCESS_ROUTE,
  FILE_ACCESS_SKEW_MS,
  FileAccessResSchema,
  type FileAccessRes,
} from '@tm/shared';
import { auth } from '$lib/firebase/auth.svelte';
import type { ViewerFile } from './types';

export interface FileSourceDeps {
  fetch: typeof fetch;
  getToken(forceRefresh?: boolean): Promise<string | null>;
  now(): number;
}

export interface FileTextResult {
  text: string;
  /** The file is bigger than what was read. */
  truncated: boolean;
}

/** Paths kept in each cache (a board's Files tab is far smaller than this). */
const MAX_CACHED = 40;
const MAX_ACCESS_CACHED = 200;

function clip(r: FileTextResult, maxBytes: number): FileTextResult {
  return r.text.length > maxBytes ? { text: r.text.slice(0, maxBytes), truncated: true } : r;
}

export function createFileSource(deps: FileSourceDeps) {
  interface Entry {
    access: Promise<FileAccessRes | null>;
    /** Provisional until the response lands, then the server's own time. */
    expiresAt: number;
  }
  const accesses = new Map<string, Entry>();
  const texts = new Map<string, Promise<FileTextResult>>();

  async function request(path: string): Promise<FileAccessRes | null> {
    const url = `${FILE_ACCESS_ROUTE}?path=${encodeURIComponent(path)}`;
    const send = async (token: string | null) =>
      deps.fetch(url, {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    let res = await send(await deps.getToken());
    // The ID token may have just expired: refresh once and try again.
    if (res.status === 401) res = await send(await deps.getToken(true));
    if (!res.ok) return null;
    const parsed = FileAccessResSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  }

  /** Access for one path, reused until it is close to expiring. */
  function accessFor(path: string | null | undefined): Promise<FileAccessRes | null> {
    if (!path) return Promise.resolve(null);
    const hit = accesses.get(path);
    if (hit && hit.expiresAt > deps.now() + FILE_ACCESS_SKEW_MS) return hit.access;
    // Provisional: long enough that parallel cards share one request, replaced
    // by the real expiry as soon as the answer arrives.
    const entry: Entry = { access: Promise.resolve(null), expiresAt: deps.now() + 60_000 };
    entry.access = request(path)
      .catch(() => null)
      .then((a) => {
        // A refusal is not cached — opening the file again retries.
        if (!a) accesses.delete(path);
        else if (accesses.get(path) === entry) entry.expiresAt = a.expiresAt;
        return a;
      });
    accesses.set(path, entry);
    if (accesses.size > MAX_ACCESS_CACHED) accesses.delete(accesses.keys().next().value!);
    return entry.access;
  }

  /** Storage path → a URL an <img> / <video> / <audio> / <iframe> can use. */
  const fileUrl = async (path: string | null | undefined): Promise<string | null> =>
    (await accessFor(path))?.url ?? null;

  /** Storage path → a same-origin URL fetch() may read (Range supported). */
  const fileBytesUrl = async (path: string | null | undefined): Promise<string | null> =>
    (await accessFor(path))?.bytesUrl ?? null;

  /**
   * The file as text, at most `maxBytes` of it (a Range read). Cached per path
   * and size; a failed read is not cached, so opening it again retries.
   */
  function fileText(
    file: Pick<ViewerFile, 'path' | 'size'>,
    maxBytes: number,
  ): Promise<FileTextResult> {
    const key = `${file.path}|${maxBytes}`;
    // A bigger read already cached serves a smaller one too.
    for (const [k, v] of texts) {
      const [p, n] = k.split('|');
      if (p === file.path && Number(n) >= maxBytes) return v.then((r) => clip(r, maxBytes));
    }
    let p = texts.get(key);
    if (!p) {
      p = read(file.path, maxBytes)
        .then((text) => ({ text, truncated: file.size > maxBytes }))
        .catch((e: unknown) => {
          texts.delete(key);
          throw e;
        });
      texts.set(key, p);
      if (texts.size > MAX_CACHED) texts.delete(texts.keys().next().value!);
    }
    return p;
  }

  async function read(path: string, maxBytes: number): Promise<string> {
    const url = await fileBytesUrl(path);
    if (!url) throw new Error('This file is not available');
    const res = await deps.fetch(url, { headers: { range: `bytes=0-${maxBytes - 1}` } });
    // 206 is the Range answer; 200 means the whole (small) file came back.
    if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  /**
   * Save the file under its own name. The bytes URL is same-origin, so a plain
   * <a download> keeps the name (and the server marks it as an attachment) —
   * no reading the whole file into memory first.
   */
  async function downloadFile(file: Pick<ViewerFile, 'path' | 'name' | 'size'>): Promise<boolean> {
    const url = await fileBytesUrl(file.path);
    if (!url) return false;
    const a = document.createElement('a');
    a.href = `${url}&dl=1`;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  /** Forget every cached URL and text (sign-out, or a file that changed). */
  function clearFileCache(): void {
    accesses.clear();
    texts.clear();
  }

  return { fileUrl, fileBytesUrl, fileText, downloadFile, clearFileCache, fileAccess: accessFor };
}

const source = createFileSource({
  fetch: (...args) => fetch(...args),
  getToken: (force) => auth.idToken(force),
  now: () => Date.now(),
});

export const fileUrl = source.fileUrl;
export const fileBytesUrl = source.fileBytesUrl;
export const fileText = source.fileText;
export const downloadFile = source.downloadFile;
export const clearFileCache = source.clearFileCache;
/** { url, bytesUrl, expiresAt } for a path (cached until close to expiry); null when refused. */
export const fileAccess = source.fileAccess;
