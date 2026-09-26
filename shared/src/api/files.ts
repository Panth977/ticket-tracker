/**
 * FILE ACCESS FOR THE APP (docs/plan/agents.html §I) — the contract between
 * the SPA and the two little routes that hand it a file's bytes.
 *
 * WHY THIS EXISTS. The browser used to read a ticket file straight out of
 * Cloud Storage (getBlob / getDownloadURL), which the Storage rules allowed by
 * looking the board up with a CROSS-SERVICE firestore.get(). In production that
 * lookup fails, and a failed lookup is a rule ERROR, which is a 403: a file an
 * agent uploaded showed "Could not load this file" while an avatar — whose
 * rule is a plain signedIn(), with no firestore.get — loaded from the same
 * bucket in the same session. The backend already owns every access decision
 * (can(read) on the board), so it hands out the bytes instead:
 *
 *   GET /api/files/url?path=…      ID token  → { url, bytesUrl, expiresAt }
 *   GET /api/files/blob?path=…&exp=…&sig=…   → the bytes (Range, no session)
 *
 * `url` is a v4 SIGNED URL (15 min) in production, so media streams straight
 * from Cloud Storage — good for <img> / <video> / <audio> / a PDF frame, which
 * need no CORS. `bytesUrl` is SAME-ORIGIN and streams through the API: fetch(),
 * the Range read the text previews use, and Download go through it, because a
 * cross-origin signed URL would need a bucket CORS configuration nobody can set
 * from here. Where signing is impossible (the Storage emulator has no service
 * account) both are the same same-origin URL.
 *
 * Neither URL is ever stored: they are minted per view and expire.
 */
import { z } from 'zod';

/** GET with the Firebase ID token: ?path=<storage path> → FileAccessRes. */
export const FILE_ACCESS_ROUTE = '/api/files/url';

/**
 * GET with no session: ?path=&exp=&sig= (&dl=1 to download). The signature is
 * the capability — the board check already happened when it was minted, which
 * is exactly how a signed URL behaves.
 */
export const FILE_BYTES_ROUTE = '/api/files/blob';

export const FileAccessResSchema = z.object({
  /** Best URL for a media `src`: a v4 signed URL when one can be signed. */
  url: z.string(),
  /** Same-origin URL that streams the bytes through the API (fetch / Range / download). */
  bytesUrl: z.string(),
  /** Epoch ms after which both stop working. */
  expiresAt: z.number(),
});
export type FileAccessRes = z.infer<typeof FileAccessResSchema>;

/** Stop reusing a minted URL this long before it really expires (clock skew, slow reads). */
export const FILE_ACCESS_SKEW_MS = 60_000;
