/** sharp transforms, no emulator. */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  isThumbnailable,
  makeAvatar,
  makeThumbnail,
  parseAvatarPath,
} from '../../src/search/images.js';

export const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toBuffer();

describe('images', () => {
  it('thumbnails fit inside 400px as webp and report the original size', async () => {
    const { thumb, original } = await makeThumbnail(await png(1600, 900));
    expect(original).toEqual({ width: 1600, height: 900 });
    expect([thumb.width, thumb.height]).toEqual([400, 225]);
    expect((await sharp(thumb.data).metadata()).format).toBe('webp');
  });

  it('never enlarges a small image', async () => {
    const { thumb } = await makeThumbnail(await png(120, 80));
    expect([thumb.width, thumb.height]).toEqual([120, 80]);
  });

  it('applies EXIF rotation to the reported dimensions', async () => {
    const rotated = await sharp(await png(300, 100))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { original, thumb } = await makeThumbnail(rotated);
    expect(original).toEqual({ width: 100, height: 300 });
    expect([thumb.width, thumb.height]).toEqual([100, 300]);
  });

  it('avatars are 256px squares', async () => {
    const out = await makeAvatar(await png(640, 480));
    expect([out.width, out.height]).toEqual([256, 256]);
    const m = await sharp(out.data).metadata();
    expect([m.format, m.width, m.height]).toEqual(['webp', 256, 256]);
  });

  it('rejects garbage', async () => {
    await expect(makeThumbnail(new TextEncoder().encode('not an image'))).rejects.toThrow();
  });

  it('classifies content types and avatar paths', () => {
    expect(isThumbnailable('image/png')).toBe(true);
    expect(isThumbnailable('image/svg+xml')).toBe(false);
    expect(isThumbnailable('application/pdf')).toBe(false);
    expect(isThumbnailable(undefined)).toBe(false);
    expect(parseAvatarPath('users/u1/avatar/123.webp')).toEqual({ uid: 'u1', file: '123.webp' });
    expect(parseAvatarPath('users/u1/other/123.webp')).toBeNull();
  });
});
