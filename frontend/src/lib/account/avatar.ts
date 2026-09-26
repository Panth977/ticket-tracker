/**
 * Profile picture: pick → crop (square, drag + zoom) → 256px WebP →
 * users/{uid}/avatar/{millis}.webp → profileUpdate({ avatarPath }).
 * The server checks the object exists and is an image, then deletes the
 * previous picture (profileUpdate).
 */
import { ref, uploadBytes } from 'firebase/storage';
import { MAX_AVATAR_BYTES, storage } from '@tm/shared';
import { getStorageClient } from '$lib/firebase/client';

export const AVATAR_SIZE = 256;
/** Accept anything the browser can decode, up to 20 MB before we shrink it. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export interface CropState {
  /** 1 = the image just covers the frame. */
  zoom: number;
  /** Offset of the image centre from the frame centre, in frame pixels. */
  x: number;
  y: number;
}

export interface SourceRect {
  sx: number;
  sy: number;
  size: number;
}

/** Scale at which an image of w×h just covers a square frame of `frame` px. */
export function coverScale(w: number, h: number, frame: number): number {
  return frame / Math.min(w, h);
}

/**
 * Keep the frame covered: the offset may not reveal empty space at any edge.
 * Returns the clamped state.
 */
export function clampCrop(c: CropState, w: number, h: number, frame: number): CropState {
  const zoom = Math.min(Math.max(c.zoom, 1), 4);
  const s = coverScale(w, h, frame) * zoom;
  const maxX = Math.max(0, (w * s - frame) / 2);
  const maxY = Math.max(0, (h * s - frame) / 2);
  return { zoom, x: Math.min(maxX, Math.max(-maxX, c.x)), y: Math.min(maxY, Math.max(-maxY, c.y)) };
}

/** The square of the SOURCE image that the frame shows. */
export function sourceRect(c: CropState, w: number, h: number, frame: number): SourceRect {
  const k = clampCrop(c, w, h, frame);
  const s = coverScale(w, h, frame) * k.zoom;
  const size = frame / s;
  const sx = w / 2 - k.x / s - size / 2;
  const sy = h / 2 - k.y / s - size / 2;
  return { sx: Math.max(0, Math.min(w - size, sx)), sy: Math.max(0, Math.min(h - size, sy)), size };
}

export function checkFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return 'Pick an image file (PNG, JPEG, WebP…).';
  if (file.size > MAX_SOURCE_BYTES) return 'That image is over 20 MB — pick a smaller one.';
  return null;
}

export async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Could not read that image.');
  }
}

/** Draw the crop into a 256px square WebP (JPEG where WebP encoding is missing). */
export async function renderAvatar(
  img: HTMLImageElement,
  crop: CropState,
  frame: number,
): Promise<Blob> {
  const r = sourceRect(crop, img.naturalWidth, img.naturalHeight, frame);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.sx, r.sy, r.size, r.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.9));
  if (blob && blob.type === 'image/webp') return blob;
  const jpeg = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (!jpeg) throw new Error('Could not encode the picture.');
  return jpeg;
}

/** Upload to users/{uid}/avatar/{millis}.webp; returns the Storage path. */
export async function uploadAvatar(uid: string, blob: Blob, now = Date.now()): Promise<string> {
  if (blob.size > MAX_AVATAR_BYTES) throw new Error('The cropped picture is too large.');
  const path = storage.avatar(uid, now);
  await uploadBytes(ref(getStorageClient(), path), blob, {
    contentType: blob.type || 'image/webp',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return path;
}

/** Upload an agent's picture to users/{ownerUid}/agents/{agentId}/avatar/{millis}.webp (agents.html §B). */
export async function uploadAgentAvatar(
  ownerUid: string,
  agentId: string,
  blob: Blob,
  now = Date.now(),
): Promise<string> {
  if (blob.size > MAX_AVATAR_BYTES) throw new Error('The cropped picture is too large.');
  const path = storage.agentAvatar(ownerUid, agentId, now);
  await uploadBytes(ref(getStorageClient(), path), blob, {
    contentType: blob.type || 'image/webp',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return path;
}
