/**
 * An Admin SDK credential from the gcloud CLI's signed-in account, for the
 * one-off data scripts (scripts/migrate-*.mjs, repair-*.mjs) on a machine with
 * no application-default login:
 *
 *   TM_GCLOUD_ACCOUNT=you@example.com node scripts/<script>.mjs --project <id> …
 *
 * Each call asks `gcloud auth print-access-token` for a short-lived token; it
 * is kept in memory only (never written to disk) and refreshed before it ends.
 * Returns null when TM_GCLOUD_ACCOUNT is not set (then use applicationDefault()).
 */
import { execFileSync } from 'node:child_process';

export function gcloudCredential() {
  const account = process.env.TM_GCLOUD_ACCOUNT;
  if (!account) return null;
  return {
    async getAccessToken() {
      const token = execFileSync('gcloud', ['auth', 'print-access-token', '--account', account], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      }).trim();
      // gcloud's tokens live an hour; claim 50 minutes so the SDK refreshes early.
      return { access_token: token, expires_in: 3000 };
    },
  };
}

/**
 * Firestore + Storage clients on that same gcloud account, for scripts that
 * need them: firebase-admin's getFirestore / getStorage accept only a
 * service-account or application-default credential, so these are built on
 * the Google Cloud libraries underneath (the same ones the Admin SDK wraps,
 * same API). `requireFrom` resolves them where firebase-admin lives.
 * Returns null when TM_GCLOUD_ACCOUNT is not set.
 */
export function gcloudClients(project, requireFrom) {
  const cred = gcloudCredential();
  if (!cred) return null;
  const { createRequire } = requireFrom;
  const fromAdmin = createRequire.call(null, requireFrom.adminEntry);
  const { Firestore, FieldValue } = fromAdmin('@google-cloud/firestore');
  const { Storage } = fromAdmin('@google-cloud/storage');
  const { OAuth2Client } = createRequire.call(
    null,
    fromAdmin.resolve('@google-cloud/firestore'),
  )('google-auth-library');
  const authClient = new OAuth2Client();
  authClient.quotaProjectId = project;
  authClient.refreshHandler = async () => {
    const t = await cred.getAccessToken();
    return { access_token: t.access_token, expiry_date: Date.now() + t.expires_in * 1000 };
  };
  const db = new Firestore({ projectId: project, authClient, preferRest: true });
  const storage = new Storage({ projectId: project, authClient });
  return { db, storage, FieldValue };
}
