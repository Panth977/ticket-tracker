/**
 * OWNER-FIRST URLS (agents.html §AC) on the app's existing pages:
 *
 *   /{handle}/b/{KEY}/…          → /b/{KEY}/…        (a KEY is global)
 *   /{handle}/x/{slug}/…         → /x/{id}/…         (the slug resolved by pathResolve)
 *   /{handle}/bucket/{slug}/…    → /bucket/{id}/…
 *   /{handle}/dictionary/{slug}/… → /dictionary/{id}/…
 *   /{handle}  /{handle}/settings/…  → /o/{handle}…  (the owner's page)
 *
 * The address bar keeps the owner-first URL; the old forms still work and
 * CanonicalUrl rewrites them in place once the thing is known.
 */
import type { Reroute } from '@sveltejs/kit';
import { parseOwnerPath, parseThingPath } from '$lib/orgs/path';

const slugIds = new Map<string, string>();

export const reroute: Reroute = async ({ url }) => {
  const t = parseThingPath(url.pathname);
  if (t?.handle) {
    if (t.kind === 'board') return `/b/${encodeURIComponent(t.ref)}${t.rest}`;
    const key = `${t.handle}/${t.kind}/${t.ref}`;
    let id = slugIds.get(key);
    if (!id && typeof window !== 'undefined') {
      try {
        const { command } = await import('$lib/api');
        const r = await command('pathResolve', { handle: t.handle, kind: t.kind, slug: t.ref });
        if (r.thing) {
          id = r.thing.id;
          slugIds.set(key, id);
        }
      } catch {
        /* not found / not mine: the page under the id route says so */
      }
    }
    const seg = t.kind === 'artifact' ? 'x' : t.kind;
    return `/${seg}/${encodeURIComponent(id ?? t.ref)}${t.rest}`;
  }
  const o = parseOwnerPath(url.pathname);
  if (o) return `/o/${encodeURIComponent(o.handle)}${o.rest}`;
};
