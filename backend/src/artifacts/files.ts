/**
 * An artifact's OBJECTS in Storage that people are handed a link to: the
 * files its viewers uploaded through db.storage (artifacts/{id}/files/…) and
 * the source zip kept beside a build (artifacts/{id}/source/{buildId}.zip).
 *
 * READS NEVER GO THROUGH STORAGE RULES (storage.rules header: the
 * cross-service firestore.get() errors instead of denying). The role is
 * checked HERE, by the command, and what comes back is a link that needs no
 * session — which is the only kind an opaque-origin iframe, or a CLI, can use:
 *
 *   deployed   a v4 SIGNED URL straight to Cloud Storage (the bytes never
 *              touch the function). Signing needs the Token Creator role on
 *              the function's service account; without it we fall through to
 *   otherwise  the /c route on the usercontent origin with an OBJECT
 *              capability (artifacts/capability.ts) — also what the emulators
 *              use, where nothing can be signed. It streams with the same
 *              sandbox headers as a build file, so an uploaded .html is as
 *              harmless as a published one.
 */
import { artifactPrefix, SIGNED_URL_TTL_MS } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { objectUrl } from './capability.js';

/** `object` is relative to artifacts/{artifactId}/ ('files/a/b.png', 'source/{buildId}.zip'). */
export async function objectLink(
  artifactId: string,
  object: string,
  uid: string,
  now: number,
): Promise<{ url: string; expiresAt: number }> {
  const expiresAt = now + SIGNED_URL_TTL_MS;
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    try {
      const url = await ports().files.signedDownloadUrl(
        `${artifactPrefix.storageAll(artifactId)}${object}`,
        expiresAt,
      );
      return { url, expiresAt };
    } catch (e) {
      console.warn(
        '[artifacts] could not sign a download URL; streaming instead',
        (e as Error).message,
      );
    }
  }
  return { url: objectUrl(artifactId, object, uid, expiresAt), expiresAt };
}

/** 'artifacts/{id}/files/a/b.png' → 'files/a/b.png' (what a capability names). */
export const objectOf = (artifactId: string, fullPath: string): string =>
  fullPath.slice(artifactPrefix.storageAll(artifactId).length);
