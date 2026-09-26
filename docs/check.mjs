// Every reference in docs/data resolves to something. Run: node docs/check.mjs
import { ALL, byRef, TYPES, MIDDLEWARE, anchorOf, homeOf } from './model.js';
let bad = 0;
for (const n of ALL) {
  const refs = [...(n.uses ?? []), ...(n.reads ?? []), ...(n.calls ?? []), ...(n.steps ?? []).flatMap((s) => s.uses ?? [])];
  for (const r of refs) if (!byRef(r)) { bad++; console.log(`✗ ${n.ref} → ${r}`); }
}
for (const n of ALL) if (n.kind === 'backend' && n.middleware && !MIDDLEWARE.some((m) => m.env === n.env && m.name === n.middleware)) { bad++; console.log(`✗ ${n.ref} middleware ${n.middleware}`); }
console.log(`${ALL.length} entities, ${TYPES.length} types, ${MIDDLEWARE.length} middleware — ${bad ? bad + ' broken' : 'all references resolve'}`);
// Anchors used by the hand-written plan pages
import { readFileSync, readdirSync } from 'node:fs';
const known = new Set([...ALL, ...TYPES, ...MIDDLEWARE].map((n) => `${homeOf(n)}#${anchorOf(n)}`));
for (const f of readdirSync(new URL('./plan', import.meta.url))) {
  if (!f.endsWith('.html')) continue;
  for (const [, href] of readFileSync(new URL('./plan/' + f, import.meta.url), 'utf8').matchAll(/href="(\/(?:app|platform)\/[a-z]+#[^"]+)"/g))
    if (!known.has(href)) { bad++; console.log(`✗ plan/${f} → ${href}`); }
}
process.exit(bad ? 1 : 0);
