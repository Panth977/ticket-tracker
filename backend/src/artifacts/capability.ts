/**
 * THE CAPABILITY IN THE URL (docs/plan/artifacts.html §D2).
 *
 * An artifact runs in a sandboxed iframe with an opaque origin: it has no
 * cookies and no Firebase session, so it cannot authenticate a request for
 * its own files. The URL therefore carries the permission itself —
 *
 *   {usercontent origin}/c/{capability}/index.html
 *
 * — and because the capability is a PATH SEGMENT, every relative URL of the
 * build (./assets/app.js) carries it without the artifact knowing.
 *
 * A capability is `base64url(JSON) . HMAC-SHA256`, signed with the server's
 * own signing key (TM_SIGNING_KEY: runtime/deploy.ts loads it from
 * _config/serverSecrets in production, platform/crypto.ts uses a fixed dev key
 * under the emulators). serverMac namespaces the MAC by purpose, so nothing
 * else this server signs can stand in for one. It says exactly one thing:
 *
 *   { a: artifactId, u: uid, e: expiry, b: buildId }     the files of ONE build
 *   { a: artifactId, u: uid, e: expiry, o: object }      ONE object of the artifact
 *                                                         ('files/…' or 'source/….zip')
 *
 * It is minted only after a role check (artifactOpen, artifactFileUrl,
 * artifactSourceUrl) and is NOT re-checked against the access map per file —
 * that would be a Firestore read per asset. Taking access away therefore
 * stops DATA at once (the rules read the map on every call) and FILE links
 * within the hour, which is what §B promises.
 *
 * WHERE {usercontent origin} IS (artifactOrigin):
 *   TM_ARTIFACT_ORIGIN when set;
 *   else, deployed: https://{projectId}-usercontent.web.app — the second
 *     Hosting site, whose only rewrite is /c/** → this function;
 *   else, under the emulators: the functions emulator's own URL for `api`
 *     (http://127.0.0.1:5101/demo-taskmanager/us-central1/api). That is a
 *     different origin from the dev app (vite on :5190), exactly as in
 *     production, and it needs nothing extra running.
 */
import { ARTIFACT_CAPABILITY_TTL_MS } from '@tm/shared';
import { safeEqual, serverMac } from '../platform/crypto.js';
import { region } from '../runtime/deploy.js';
import { isEmulated, projectId } from '../runtime/firebase.js';

const PURPOSE = 'artifact-capability';
/** The functions emulator's port in firebase.json (scripts/ports.mjs PORTS.functions). */
const DEV_FUNCTIONS_PORT = 5101;

export interface BuildCapability {
  artifactId: string;
  uid: string;
  exp: number;
  buildId: string;
}
export interface ObjectCapability {
  artifactId: string;
  uid: string;
  exp: number;
  /** Relative to artifacts/{artifactId}/ — 'files/…' or 'source/{buildId}.zip'. */
  object: string;
}
export type Capability = BuildCapability | ObjectCapability;

/** The wire form: short keys, because this string is in every asset URL. */
interface Wire {
  a: string;
  u: string;
  e: number;
  b?: string;
  o?: string;
}

export function artifactOrigin(): string {
  const env = process.env.TM_ARTIFACT_ORIGIN?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (isEmulated()) return `http://127.0.0.1:${DEV_FUNCTIONS_PORT}/${projectId()}/${region()}/api`;
  return `https://${projectId()}-usercontent.web.app`;
}

export function signCapability(cap: Capability): string {
  const wire: Wire = {
    a: cap.artifactId,
    u: cap.uid,
    e: cap.exp,
    ...('buildId' in cap ? { b: cap.buildId } : { o: cap.object }),
  };
  const body = Buffer.from(JSON.stringify(wire)).toString('base64url');
  return `${body}.${serverMac(PURPOSE, body)}`;
}

export type CapabilityVerdict =
  { ok: true; cap: Capability } | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Check a capability. The signature is compared in constant time BEFORE the
 * body is parsed, so nothing unsigned is ever interpreted; only then the
 * expiry. 'expired' is told apart because the host page can act on it (ask
 * for a fresh one); everything else is just 'invalid'.
 */
export function verifyCapability(token: string, now: number): CapabilityVerdict {
  const bad = { ok: false, reason: 'invalid' } as const;
  if (typeof token !== 'string' || token.length > 2048) return bad;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return bad;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !safeEqual(sig, serverMac(PURPOSE, body))) return bad;
  let w: Wire;
  try {
    w = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Wire;
  } catch {
    return bad;
  }
  if (!w || typeof w.a !== 'string' || typeof w.u !== 'string' || typeof w.e !== 'number')
    return bad;
  const isBuild = typeof w.b === 'string' && w.o === undefined;
  const isObject = typeof w.o === 'string' && w.b === undefined;
  if (!isBuild && !isObject) return bad;
  if (!Number.isFinite(w.e) || w.e <= now) return { ok: false, reason: 'expired' };
  const base = { artifactId: w.a, uid: w.u, exp: w.e };
  return { ok: true, cap: isBuild ? { ...base, buildId: w.b! } : { ...base, object: w.o! } };
}

/** What artifactOpen hands the host page: the prefix every file of the build lives under. */
export function buildUrls(
  artifactId: string,
  buildId: string,
  uid: string,
  now: number,
): { contentBase: string; contentUrl: string; expiresAt: number } {
  const expiresAt = now + ARTIFACT_CAPABILITY_TTL_MS;
  const cap = signCapability({ artifactId, buildId, uid, exp: expiresAt });
  const contentBase = `${artifactOrigin()}/c/${cap}/`;
  return { contentBase, contentUrl: `${contentBase}index.html`, expiresAt };
}

/**
 * A URL for ONE object of the artifact, served by the same /c route. The last
 * segment is only a name (for the Save dialog and for anything that guesses a
 * type from the extension) — the object is named by the capability, so the
 * path cannot be edited to reach another one.
 */
export function objectUrl(
  artifactId: string,
  object: string,
  uid: string,
  expiresAt: number,
): string {
  const cap = signCapability({ artifactId, object, uid, exp: expiresAt });
  const name = object.split('/').pop() || 'file';
  return `${artifactOrigin()}/c/${cap}/${encodeURIComponent(name)}`;
}
