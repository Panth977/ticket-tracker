/**
 * SECRETS IN DRIVE (docs/plan/bucket.html §L6).
 *
 * Each Drive entity has its own random 256-bit DATA KEY. A secret subtree's
 * files (a board's webhooks and integrations, a dictionary's entries) are
 * AES-256-GCM sealed with it; everything else stays plain JSON.
 *
 * The data key lives next to them, in `<entity folder>/.tm-keys.json`, wrapped
 * twice:
 *
 *   instance   sealed with this instance's server key — opened on every read
 *   recovery   wrapped (X25519 + HKDF + AES-GCM) to the Drive owner's RECOVERY
 *              key, whose private half is the recovery code we show them once
 *              (Account › Google Drive). Only they have it.
 *
 * Another instance cannot open the instance wrap. Given the recovery code
 * (importing the folder, §L7), it opens the recovery wrap and re-seals the key
 * for itself. Lose the code and the old instance together, and the secrets
 * are gone; every non-secret file is plain JSON and survives.
 *
 * The database keeps only `_driveVaults/{uid}`: the recovery PUBLIC key, and —
 * until the person has seen it — the code itself, sealed.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { errors } from '@tm/shared';
import type { DriveEntity } from './board.js';
import { driveOf } from './board.js';
import { readDocFile, writeDocFile, type Sealer } from './docfiles.js';

type Json = Record<string, unknown>;

export const VAULTS = '_driveVaults';
const KEYS_FILE = '.tm-keys';

// ─── the recovery code ───────────────────────────────────────────────────────

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

export function encodeCode(seed: Buffer): string {
  let bits = '';
  for (const b of seed) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g)!.join('-');
}

export function decodeCode(code: string): Buffer {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  let bits = '';
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw errors.invalid('That is not a recovery code', { field: 'recoveryCode' });
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length && bytes.length < 32; i += 8)
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  if (bytes.length !== 32)
    throw errors.invalid('That recovery code is too short', { field: 'recoveryCode' });
  return Buffer.from(bytes);
}

// ─── X25519 ──────────────────────────────────────────────────────────────────

const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const privFromSeed = (seed: Buffer): KeyObject =>
  createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const rawPub = (k: KeyObject): Buffer =>
  (createPublicKey(k).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
const pubFromRaw = (raw: Buffer): KeyObject =>
  createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

export const publicKeyOfSeed = (seed: Buffer): string =>
  rawPub(privFromSeed(seed)).toString('base64url');

const kekOf = (shared: Buffer, eph: Buffer) =>
  Buffer.from(hkdfSync('sha256', shared, eph, 'tm-drive-recovery', 32));

function gcm(key: Buffer, plain: Buffer): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return {
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: c.getAuthTag().toString('base64url'),
  };
}
function ungcm(key: Buffer, b: { iv: string; ct: string; tag: string }): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64url'));
  d.setAuthTag(Buffer.from(b.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(b.ct, 'base64url')), d.final()]);
}

/** Wrap `dek` to a recovery public key. */
export function wrapToRecovery(pub: string, dek: Buffer): Json {
  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawPub(eph.privateKey);
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: pubFromRaw(Buffer.from(pub, 'base64url')),
  });
  return {
    alg: 'x25519-hkdf-aesgcm',
    eph: ephRaw.toString('base64url'),
    ...gcm(kekOf(shared, ephRaw), dek),
  };
}

/** Open a recovery wrap with the recovery code's seed. */
export function unwrapWithRecovery(seed: Buffer, w: Json): Buffer {
  const eph = Buffer.from(String(w.eph), 'base64url');
  const shared = diffieHellman({ privateKey: privFromSeed(seed), publicKey: pubFromRaw(eph) });
  try {
    return ungcm(kekOf(shared, eph), w as { iv: string; ct: string; tag: string });
  } catch {
    throw errors.invalid('That recovery code does not open this folder', { field: 'recoveryCode' });
  }
}

// ─── vaults (the database's part) ────────────────────────────────────────────

async function link() {
  return import('../../bucket/drive/link.js');
}
async function db() {
  return (await import('../index.js')).baseDb();
}

/** The person's recovery public key — made (and its code kept, sealed, to show once) on first use. */
export async function recoveryPublicKey(uid: string): Promise<string> {
  const ref = (await db()).doc(`${VAULTS}/${uid}`);
  const snap = await ref.get();
  const cur = snap.exists ? (snap.data() as { pub?: string }) : undefined;
  if (cur?.pub) return cur.pub;
  const seed = randomBytes(32);
  const pub = publicKeyOfSeed(seed);
  const { seal } = await link();
  await ref.set({ pub, pendingCode: seal(encodeCode(seed)), createdAt: Date.now(), shownAt: null });
  return pub;
}

/** The recovery code, once: answered and forgotten. null when already shown (or none yet). */
export async function takeRecoveryCode(uid: string): Promise<string | null> {
  const ref = (await db()).doc(`${VAULTS}/${uid}`);
  const snap = await ref.get();
  const cur = snap.exists ? (snap.data() as { pendingCode?: string | null }) : undefined;
  if (!cur?.pendingCode) return null;
  const { unseal } = await link();
  const code = unseal(cur.pendingCode);
  await ref.set({ pendingCode: null, shownAt: Date.now() }, { merge: true });
  return code;
}

export async function vaultStatus(uid: string): Promise<{ has: boolean; pending: boolean }> {
  const snap = await (await db()).doc(`${VAULTS}/${uid}`).get();
  const cur = snap.exists
    ? (snap.data() as { pub?: string; pendingCode?: string | null })
    : undefined;
  return { has: !!cur?.pub, pending: !!cur?.pendingCode };
}

// ─── data keys (Drive's part) ────────────────────────────────────────────────

const deks = new Map<string, Buffer>();
/** Tests. */
export const clearDataKeys = () => deks.clear();

/**
 * The entity's data key: from `.tm-keys.json` (made on first use). A folder
 * sealed by another instance needs `recoverySeed` (§L7 import) — without it,
 * a 409 says so.
 */
export async function dataKeyOf(e: DriveEntity, recoverySeed?: Buffer): Promise<Buffer> {
  const hit = deks.get(e.folderId);
  if (hit && !recoverySeed) return hit;
  const drive = await driveOf(e);
  const { doc } = await readDocFile(drive, e.folderId, [KEYS_FILE], null);
  const { seal, unseal } = await link();
  let dek: Buffer;
  if (!doc) {
    dek = randomBytes(32);
    const keys = {
      schema: 'tm/keys@1',
      instance: seal(dek.toString('base64url')),
      recovery: wrapToRecovery(await recoveryPublicKey(e.uid), dek),
      createdAt: new Date().toISOString(),
    };
    await writeDocFile(drive, e.folderId, [KEYS_FILE], keys, null);
  } else {
    let opened: Buffer | null = null;
    try {
      opened = Buffer.from(unseal(String(doc.instance)), 'base64url');
    } catch {
      opened = null;
    }
    if (!opened) {
      if (!recoverySeed)
        throw errors.conflict(
          'The secrets in this Drive folder were sealed by another TaskManager — enter its recovery code',
          { reason: 'drive_locked' },
        );
      opened = unwrapWithRecovery(recoverySeed, doc.recovery as Json);
      // Re-seal for this instance: from now on it opens without the code.
      await writeDocFile(
        drive,
        e.folderId,
        [KEYS_FILE],
        { ...doc, instance: seal(opened.toString('base64url')) },
        null,
      );
    }
    dek = opened;
  }
  deks.set(e.folderId, dek);
  return dek;
}

const SEALED = 'tm/sealed@1';

/** Seal / open a secret file of this entity. A file that is not sealed (written by hand) reads as it is. */
export async function sealerFor(e: DriveEntity): Promise<Sealer> {
  return {
    async seal(json) {
      const dek = await dataKeyOf(e);
      return { $tm: SEALED, ...gcm(dek, Buffer.from(JSON.stringify(json), 'utf8')) };
    },
    async open(json) {
      if (json.$tm !== SEALED) return json;
      const dek = await dataKeyOf(e);
      return JSON.parse(
        ungcm(dek, json as { iv: string; ct: string; tag: string }).toString('utf8'),
      ) as Json;
    },
  };
}
