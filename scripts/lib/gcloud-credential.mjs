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
  // One OAuth2Client per library: each Cloud library ships its own
  // google-auth-library, and checks the client against ITS classes.
  const account = process.env.TM_GCLOUD_ACCOUNT;
  const token = () =>
    execFileSync('gcloud', ['auth', 'print-access-token', '--account', account], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  const clientFor = (lib) => {
    const { OAuth2Client } = createRequire.call(
      null,
      fromAdmin.resolve(lib),
    )('google-auth-library');
    const c = new OAuth2Client();
    c.quotaProjectId = project;
    c.refreshHandler = async () => ({
      access_token: token(),
      expiry_date: Date.now() + 3000 * 1000,
    });
    // Seeded now: a client with no credentials yet can be taken for anonymous.
    c.setCredentials({ access_token: token(), expiry_date: Date.now() + 3000 * 1000 });
    return c;
  };
  const db = new Firestore({
    projectId: project,
    authClient: clientFor('@google-cloud/firestore'),
    preferRest: true,
  });
  const storage = new Storage({
    projectId: project,
    authClient: clientFor('@google-cloud/storage'),
  });
  return { db, storage, FieldValue };
}
