/**
 * driveDocWrite (bucket.html §L5) — the browser's writes to a Drive artifact's
 * data (what the artifact broker would have written to Firestore). Same gate
 * as Firestore's rules (writeData); values arrive encoded ({ __ts } for a
 * Timestamp, { __sv: 'now' } for the server's time).
 */
import { errors } from '@tm/shared';
import { db, FieldValue, Timestamp } from '../db/index.js';
import { decodeJson } from '../db/drive/values.js';
import { defineCommand } from './_registry.js';
import { gateDrivePath } from './driveDocs.js';
import { assertNotArchived, loadArtifact } from '../artifacts/shared.js';

function withSentinels(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withSentinels);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && o.__sv === 'now') return FieldValue.serverTimestamp();
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = withSentinels(x);
    return out;
  }
  return v;
}

export default defineCommand('driveDocWrite', async (ctx, input) => {
  const path = input.path.replace(/^\/+|\/+$/g, '');
  const s = path.split('/');
  if (s[0] !== 'artifacts' || s[2] !== 'db')
    throw errors.forbidden('Only an artifact’s data is written this way');
  // Firestore's rule (artifactCollectionAllowed): two collection names an artifact may not use.
  if (/(^|\/)(tickets|reads)\/[^/]+/.test(input.method === 'add' ? `${path}/_` : path))
    throw errors.forbidden('An artifact cannot use a collection named tickets or reads');
  await gateDrivePath(ctx, input.method === 'add' ? `${path}/_` : path, true, true);
  const { artifact } = await loadArtifact(null, s[1]!, ctx, 'writeData');
  assertNotArchived(artifact);
  const data = input.data
    ? (withSentinels(decodeJson(input.data, Timestamp)) as Record<string, unknown>)
    : undefined;
  if (input.method === 'add') {
    const ref = await db()
      .collection(path)
      .add(data ?? {});
    return { id: ref.id };
  }
  const ref = db().doc(path);
  if (input.method === 'set') await ref.set(data ?? {}, input.merge ? { merge: true } : {});
  else if (input.method === 'update') await ref.update(data ?? {});
  else await ref.delete();
  return { id: ref.id };
});
