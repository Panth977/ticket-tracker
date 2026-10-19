/**
 * The file door's own signed link: FILE_BYTES_ROUTE?path&exp&sig — a
 * capability we mint after checking access, exactly like a Storage signed URL.
 * Used where there is no object of ours to sign (a Drive bucket's file,
 * bucket.html §K3) and as the fallback when signing is not possible.
 */
import { FILE_BYTES_ROUTE } from '@tm/shared';
import { serverMac } from './crypto.js';

export const blobSig = (path: string, exp: number): string =>
  serverMac('file-blob', `${path}\n${exp}`);

/** Relative (same origin as the app) … */
export const fileDoorPath = (path: string, exp: number): string =>
  `${FILE_BYTES_ROUTE}?path=${encodeURIComponent(path)}&exp=${exp}&sig=${encodeURIComponent(blobSig(path, exp))}`;

/** … and absolute, for agents, REST and MCP callers outside the app. */
export function fileDoorUrl(path: string, exp: number): string {
  const base = (process.env.API_URL || process.env.APP_URL || '').replace(/\/$/, '');
  return `${base}${fileDoorPath(path, exp)}`;
}
