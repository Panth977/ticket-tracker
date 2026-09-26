/**
 * Production defaults without third-party credentials (deploy-prep), no emulator:
 * region / secret bindings, off-by-default channels, the stateless search index.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmail,
  createWhatsapp,
  isNotConfigured,
  NOT_CONFIGURED,
  NotConfiguredError,
  whatsappConfigured,
} from '../src/adapters/index.js';
import { boundSecrets, ensureServerSecrets, region } from '../src/runtime/deploy.js';
import { isEmulated } from '../src/runtime/firebase.js';
import { createSearchIndex } from '../src/search/index.js';

const KEYS = [
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'FUNCTIONS_EMULATOR',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'TM_REGION',
  'TM_SECRETS',
  'RESEND_API_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'TYPESENSE_HOST',
  'TYPESENSE_API_KEY',
  'TM_SIGNING_KEY',
  'NOTIFY_SIGNING_SECRET',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Look like a deployed function: a real project id, no emulator anywhere. */
function production() {
  for (const k of KEYS) delete process.env[k];
  process.env.GCLOUD_PROJECT = 'taskmanager-prod-test';
  expect(isEmulated()).toBe(false);
}

describe('deploy config', () => {
  it('region: TM_REGION, else us-central1 (what the emulators address)', () => {
    delete process.env.TM_REGION;
    expect(region()).toBe('us-central1');
    process.env.TM_REGION = 'asia-south1';
    expect(region()).toBe('asia-south1');
  });

  it('TM_SECRETS is an optional, comma-separated list of secret names', () => {
    expect(boundSecrets({})).toEqual([]);
    expect(boundSecrets({ TM_SECRETS: '' })).toEqual([]);
    expect(boundSecrets({ TM_SECRETS: 'RESEND_API_KEY, WHATSAPP_TOKEN,,bad-name' })).toEqual([
      'RESEND_API_KEY',
      'WHATSAPP_TOKEN',
    ]);
  });

  it('server secrets: nothing to load when they are set', async () => {
    production();
    process.env.TM_SIGNING_KEY = 'a';
    process.env.NOTIFY_SIGNING_SECRET = 'b';
    await expect(ensureServerSecrets()).resolves.toBeUndefined();
  });
});

describe('production without credentials', () => {
  it('email is OFF: refuses with NotConfiguredError, never the dev outbox', async () => {
    production();
    const err = await createEmail()
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConfiguredError);
    expect(isNotConfigured(err)).toBe(true);
    expect(NOT_CONFIGURED).toBe('suppressed: not configured');
  });

  it('WhatsApp is OFF and reports it', async () => {
    production();
    expect(whatsappConfigured()).toBe(false);
    await expect(createWhatsapp().sendText('+911234567890', 'hi')).rejects.toSatisfy(
      isNotConfigured,
    );
    process.env.WHATSAPP_TOKEN = 't';
    process.env.WHATSAPP_PHONE_ID = 'p';
    expect(whatsappConfigured()).toBe(true);
  });

  it('search is the stateless Firestore index (never a per-instance memory one)', async () => {
    production();
    const index = createSearchIndex();
    expect('all' in index).toBe(false);
    // The SPA's contract: host 'memory' → search Firestore from the client.
    expect((await index.scopedKey(['b1'], Date.now() + 1000)).host).toBe('memory');
    await expect(index.search({ q: 'x', boardIds: [] })).resolves.toEqual({ hits: [], found: 0 });
  });

  it('under the emulators the dev fakes stay', () => {
    expect(isEmulated()).toBe(true);
    expect(whatsappConfigured()).toBe(true);
    expect('all' in createSearchIndex({})).toBe(true);
  });
});
