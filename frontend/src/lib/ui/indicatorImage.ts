/**
 * indicators.html — where an uploaded indicator image is drawn from.
 *
 * The bytes come through the file door (lib/files/source fileUrl, which
 * caches each signed URL until it is close to expiring). Right after an
 * upload the picker remembers the local object URL for that path, so the new
 * mark shows at once — before (and without) a round trip.
 */
const local = new Map<string, string>();

/** Remember the bytes just uploaded to `path` (an object URL). */
export function rememberIndicatorImage(path: string, objectUrl: string): void {
  local.set(path, objectUrl);
}

/** A src for the image at `path`, or null when it cannot be read. */
export async function indicatorImageUrl(path: string): Promise<string | null> {
  const hit = local.get(path);
  if (hit) return hit;
  try {
    // Imported on first use: the file door pulls in Firebase auth, which a
    // component that merely draws a colour or an emoji should not.
    const { fileUrl } = await import('$lib/files/source');
    return await fileUrl(path);
  } catch {
    return null;
  }
}
