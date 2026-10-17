/**
 * pathResolve (§AC) — what /{handle}/{kind}/{KEY | slug} names: the owner,
 * and the thing if the caller may open it (404 otherwise, never "exists but
 * not yours"). The SPA calls it for every owner-first URL.
 */
import { errors, paths, roleOf, type HandleDoc, type OwnerRef } from '@tm/shared';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { bucketRef, reachFor } from '../bucket/shared.js';
import { dictionaryRef, reachFor as dictionaryReachFor } from '../dictionary/shared.js';
import { db } from '../db/index.js';
import { boardByKey } from '../platform/resolve.js';
import { defineCommand } from './_registry.js';
import { handleOf, handleRef, ownerKeyOfThing, thingCollection } from '../org/shared.js';

export default defineCommand('pathResolve', async (ctx, input) => {
  const h = (await handleRef(input.handle.toLowerCase()).get()).data() as HandleDoc | undefined;
  if (!h) throw errors.not_found('No such user or org');
  const owner: OwnerRef = { kind: h.kind, id: h.id };
  const ownerDoc = (
    await db()
      .doc(h.kind === 'org' ? paths.org(h.id) : paths.user(h.id))
      .get()
  ).data() as { name?: string; handle?: string } | undefined;
  const name = ownerDoc?.name ?? input.handle;
  const handle = ownerDoc?.handle ?? input.handle;
  if (!input.kind || !input.slug) return { owner, handle, name, thing: null };

  const notFound = () => errors.not_found('Not found');
  if (input.kind === 'board') {
    const b = await boardByKey(ctx, input.slug).catch(() => {
      throw notFound();
    });
    if (!roleOf(b, ctx.actor)) throw notFound();
    // A board KEY is global: the handle in the URL may be stale — answer the real owner.
    const real = b.owner ?? { kind: 'user' as const, id: b.createdBy };
    return {
      owner: real,
      handle: await handleOf(real),
      name,
      thing: { kind: 'board' as const, id: b.id, slug: b.key },
    };
  }
  const col = thingCollection(input.kind);
  const hit = await db()
    .collection(col)
    .where('ownerKey', '==', ownerKeyOfThing(owner))
    .where('slug', '==', input.slug.toLowerCase())
    .limit(1)
    .get();
  const doc = hit.docs[0];
  if (!doc) throw notFound();
  if (input.kind === 'artifact') {
    const a = (await artifactRef(doc.id).get()).data();
    if (!a || !roleFor(ctx, a)) throw notFound();
  } else if (input.kind === 'dictionary') {
    const d = (await dictionaryRef(doc.id).get()).data();
    if (!d || !(await dictionaryReachFor(ctx, d))) throw notFound();
  } else {
    const m = (await bucketRef(doc.id).get()).data();
    if (!m || !(await reachFor(ctx, m))) throw notFound();
  }
  return {
    owner,
    handle,
    name,
    thing: { kind: input.kind, id: doc.id, slug: input.slug.toLowerCase() },
  };
});
