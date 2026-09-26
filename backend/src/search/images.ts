/**
 * sharp transforms for onAttachmentFinalized (app/backend.json):
 *
 *   attachment image/*  → thumb_400.webp next to it: fits inside 400×400,
 *                          never enlarged; the original's width/height recorded
 *   users/{uid}/avatar/* → centre-cropped square, 256px webp, REPLACING the original
 *
 * Pure buffer → buffer here; the trigger does the Storage / Firestore I/O.
 */
import sharp from 'sharp';

export const THUMB_SIZE = 400;
export const AVATAR_SIZE = 256;

/**
 * Custom metadata stamped on every object this code writes. The avatar is
 * rewritten IN PLACE, which fires onObjectFinalized again — the marker is
 * what stops that from looping.
 */
export const PROCESSED_META = 'tmProcessed';

/**
 * Raster formats we thumbnail. SVG is excluded on purpose: rasterising
 * untrusted SVG pulls in a whole XML/CSS engine for no benefit (the browser
 * renders the original fine). PDF previews need a PDF-capable libvips build,
 * which the prebuilt sharp binary is not — they are skipped for now.
 */
const RASTER = /^image\/(jpeg|png|webp|gif|avif|heic|heif|tiff|bmp)$/i;
export const isThumbnailable = (contentType: string | undefined) =>
  !!contentType && RASTER.test(contentType);

// Decompression-bomb guard: 50 MB upload cap, but a tiny PNG can claim 100k×100k.
const INPUT = { limitInputPixels: 100_000_000, failOn: 'error' as const };

export interface ImageOut {
  data: Buffer;
  width: number;
  height: number;
}

/** Thumbnail + the ORIGINAL's dimensions (EXIF rotation applied to both). */
export async function makeThumbnail(
  input: Uint8Array,
): Promise<{ thumb: ImageOut; original: { width: number; height: number } }> {
  const img = sharp(input, INPUT).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  // After .rotate(), 90°/270° orientations swap the stored dimensions.
  const swap = (meta.orientation ?? 1) >= 5;
  const original = {
    width: (swap ? meta.height : meta.width) ?? 0,
    height: (swap ? meta.width : meta.height) ?? 0,
  };
  const { data, info } = await img
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return { thumb: { data, width: info.width, height: info.height }, original };
}

/** Square avatar: cover-crop from the centre (attention would chase faces, but costs more). */
export async function makeAvatar(input: Uint8Array): Promise<ImageOut> {
  const { data, info } = await sharp(input, INPUT)
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** users/{uid}/avatar/{file} → uid, else null. */
export function parseAvatarPath(path: string): { uid: string; file: string } | null {
  const m = /^users\/([^/]+)\/avatar\/([^/]+)$/.exec(path);
  return m ? { uid: m[1]!, file: m[2]! } : null;
}
