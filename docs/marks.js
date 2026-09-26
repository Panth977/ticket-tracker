import LOGOS from './data/logos.json' with { type: 'json' };

/**
 * The marks beside a service, a runtime, a channel.
 *
 * THE SHAPES ARE DATA, IN `data/logos.json`, and this file only draws them.
 * They were a wall of SVG markup in a template literal here, which made adding
 * a mark an edit to a program rather than an entry in a list — and put one more
 * thing in code that is only ever content.
 *
 * ONE CATALOGUE, NAMED FROM EVERYWHERE. `db.json` says which mark a service
 * carries and `backend.json` says which one a trigger carries; both name an
 * entry here rather than carrying their own copy of the drawing.
 *
 * INLINE, NOT A CDN. This document binds to 127.0.0.1 and describes the
 * security rules; it should render from the repository alone, with no network,
 * no broken images on a train, and nothing fetched from a host that then knows
 * somebody is reading it. Sixteen pixels of path data is cheaper than a request
 * either way.
 *
 * DRAWN IN THE SHAPE OF THE REAL ONES RATHER THAN COPIED. Firestore's layered
 * stack, Storage's bucket, the Realtime Database's cylinder — the silhouettes
 * are what somebody recognises at this size, and they are recognisable at a
 * glance down a column, which is the whole job. They are approximations and
 * this comment is where that is admitted; they are not the trademarks and
 * nothing here is published.
 *
 * COLOUR IS THE FASTER SIGNAL. Every Firebase product is amber, which is true
 * to the brand and useless for telling three of them apart on one page — so
 * Cloud Storage keeps Google's blue and the Realtime Database takes a green
 * that the shop's paper does not otherwise use. Reading the label is the
 * fallback, not the mechanism.
 */

/** Every mark the document knows, by name. */
export const LOGO = new Map(LOGOS.logos.map((l) => [l.name, l]));

/*
 * A 16-unit box for all of them, so a mark drawn against one product's
 * proportions sits at the same weight as the others in the same row.
 */
const VIEW = 16;

/** `{ shape: 'path', d: '…', fill: '…' }` → `<path d="…" fill="…"/>`. */
const part = ({ shape, ...attrs }) =>
	`<${shape} ${Object.entries(attrs)
		.map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
		.join(' ')}/>`;

/** A mark, or nothing when the name is one the catalogue does not draw. */
export function markFor(name) {
	const found = LOGO.get(name);
	if (!found) return '';
	return (
		`<svg class="logo" viewBox="0 0 ${VIEW} ${VIEW}" width="14" height="14" aria-hidden="true">` +
		found.shapes.map(part).join('') +
		`</svg>`
	);
}
