/**
 * indicators.html — "Upload your own": the image goes straight to Storage at
 * indicators/{uid}/{fileId}/{name} (storage.rules: only that uid creates it,
 * ≤ 1 MB, an image type), and the indicator stores that path. Like avatars
 * (lib/account/avatar.ts), no function sits in between.
 */
import {
  INDICATOR_IMAGE_MAX_BYTES,
  INDICATOR_IMAGE_TYPES,
  INDICATOR_PATH_RE,
  storage,
} from '@tm/shared';
import { rememberIndicatorImage } from './indicatorImage';

const TYPES: readonly string[] = INDICATOR_IMAGE_TYPES;
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** Why this file cannot be an indicator, or null when it can. */
export function checkIndicatorFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!TYPES.includes(file.type)) return 'Pick a PNG, JPEG, WebP, GIF or SVG image.';
  if (file.size > INDICATOR_IMAGE_MAX_BYTES)
    return `That image is over ${Math.round(INDICATOR_IMAGE_MAX_BYTES / 1024 / 1024)} MB — pick a smaller one.`;
  if (file.size === 0) return 'That file is empty.';
  return null;
}

/** A Storage-safe object name: no slashes or control characters, ≤ 120 chars, with an extension. */
export function indicatorFileName(name: string, type: string): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[/\\\u0000-\u001f\u007f]+/g, '-').trim();
  n = n.replace(/^\.+/, '').replace(/\s+/g, ' ');
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 6 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  if (!n || n === '.' || n === '..') n = `indicator.${EXT[type] ?? 'img'}`;
  return n;
}

/** A random [A-Za-z0-9_-]{16} id. */
export function indicatorFileId(rand: (n: number) => Uint8Array = randomBytes): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  return [...rand(16)].map((b) => abc[b & 63]).join('');
}
function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** The Storage path for `uid` uploading `file`. Throws if it would not satisfy INDICATOR_PATH_RE. */
export function indicatorPathFor(
  uid: string,
  file: Pick<File, 'name' | 'type'>,
  fileId = indicatorFileId(),
): string {
  const path = storage.indicator(uid, fileId, indicatorFileName(file.name, file.type));
  if (!INDICATOR_PATH_RE.test(path))
    throw new Error('Could not name that file — rename it and try again.');
  return path;
}

/** Upload `file` as the signed-in person's indicator image; answers its Storage path. */
export async function uploadIndicatorImage(file: File): Promise<string> {
  const bad = checkIndicatorFile(file);
  if (bad) throw new Error(bad);
  // Firebase is imported on first upload, so forms that merely SHOW a picker
  // (and their component tests) do not pull in auth and Storage.
  const [{ ref, uploadBytes }, { getStorageClient }, { auth }] = await Promise.all([
    import('firebase/storage'),
    import('$lib/firebase/client'),
    import('$lib/firebase/auth.svelte'),
  ]);
  const uid = auth.user?.uid;
  if (!uid) throw new Error('Sign in to upload an image.');
  const path = indicatorPathFor(uid, file);
  await uploadBytes(ref(getStorageClient(), path), file, {
    contentType: file.type,
    cacheControl: 'public, max-age=31536000, immutable',
  });
  try {
    rememberIndicatorImage(path, URL.createObjectURL(file));
  } catch {
    // No object URLs (tests, old browsers): the file door serves it instead.
  }
  return path;
}
