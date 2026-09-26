import LOGOS from './data/logos.json' with { type: 'json' };

import APP_DB from './data/app/db.json' with { type: 'json' };
import APP_BACKEND from './data/app/backend.json' with { type: 'json' };
import APP_APP from './data/app/app.json' with { type: 'json' };
import APP_FLOWS from './data/app/flows.json' with { type: 'json' };

import PLATFORM_DB from './data/platform/db.json' with { type: 'json' };
import PLATFORM_BACKEND from './data/platform/backend.json' with { type: 'json' };
import PLATFORM_FLOWS from './data/platform/flows.json' with { type: 'json' };

/**
 * Everything this site describes, in one place.
 *
 * TWO ENVIRONMENTS, AND THEY ARE DIFFERENT SYSTEMS. `public` is the shop as a
 * customer meets it: a website, the endpoints behind it, the collections those
 * write. `business` is the shop's own side of the counter — an internal app,
 * its own endpoints, its own roles — which is being built as a Flutter app and
 * is not this website at all.
 *
 * THEY SHARE DATA AND NOT MUCH ELSE. An order is placed by a customer and moved
 * by a manager, so a business flow names `public/schema/orders` and is right to:
 * one collection, two systems, and the reference says which side is being
 * looked at from. That is why every reference carries its environment.
 *
 * WHY A MODEL AND NOT EIGHT HAND-WRITTEN PAGES. Each environment's pages are
 * views of ONE set of facts. Written out separately they would disagree within
 * a month, and nobody reads a document looking for absences.
 *
 * THE FACTS ARE JSON, IN `data/<environment>/`, AND THIS FILE IS ONLY THE SHAPE
 * OF THEM. They were object literals with the rules and schemas inside template
 * literals: content in a program, where a stray backtick took the document down
 * and writing a collection meant editing code to say something that is only
 * ever data. What is left here is what genuinely is logic — how the kinds are
 * joined, and how the edges are derived.
 *
 * EACH FILE CARRIES ITS OWN VOCABULARY AT THE TOP: the services a collection
 * can live in, the ways a script can be reached, the middleware that can stand
 * in front of one, the stage a flow step happens on. A card that names one is
 * naming something declared a few lines above it.
 *
 * CODE BLOCKS ARE ARRAYS OF LINES. A rules block as one JSON string is an
 * unreadable line of `\n` escapes whose every change is a one-line diff nobody
 * can review.
 *
 * THERE IS NO `id` FIELD ANYWHERE. A name is unique inside its list, so an id
 * would be a second key for the same thing — and a second key can disagree with
 * the first.
 *
 * EDGES ARE DECLARED ONCE, IN ONE DIRECTION. An entry lists what it USES — a
 * backend entry calls that list `touches` — and the reverse is derived.
 */

/**
 * THE TWO SIDES, AND WHAT EACH IS MADE OF.
 *
 * The public side has a WEBSITE. The business side has an APP, which is not the
 * same thing wearing a different word: it ships through a store, it has no
 * routes and no render mode, and half of what the website page says about a
 * page would be a lie about a screen.
 */
export const ENVIRONMENTS = [
	{
		name: 'app',
		label: 'App',
		note: 'The task manager as a person meets it — Svelte on Firebase.',
		kinds: ['db', 'backend', 'app', 'flow']
	},
	{
		name: 'platform',
		label: 'Platform',
		note: 'The same data reached from outside — REST, MCP, webhooks, and every notification channel.',
		kinds: ['db', 'backend', 'flow']
	}
];

/**
 * THE KINDS, named after what they are rather than after the technology.
 *
 * `db` was `schema` and its page was called Collections, which is a Firestore
 * word — and a third of what is on it is not a Firestore collection. `backend`
 * was `api`, and the same problem one layer along: a trigger is not an endpoint
 * and never was.
 */
export const KINDS = {
	db: { label: 'DB', slug: 'db' },
	backend: { label: 'Backend', slug: 'backend' },
	website: { label: 'Website', slug: 'website' },
	app: { label: 'Screens', slug: 'screens' },
	flow: { label: 'Flows', slug: 'flows' }
};

/** The address a kind is read at, inside an environment. */
export const pageOf = (env, kind) => `/${env}/${KINDS[kind].slug}`;

/** Lines back into the one string every renderer wants. */
const text = (lines) => (Array.isArray(lines) ? lines.join('\n') : (lines ?? ''));

/**
 * WHERE AN ENTITY CAME FROM, carried on the entity itself.
 *
 *   source: [ 'public/backend.json', 'proxyFunctions', 'attribution' ]
 *   ref:      'public/proxyFunctions/attribution'
 *
 * The environment, the file, the list inside it, and the entry's name. Every
 * cross-reference, every margin note and every anchor is built from this.
 *
 * A REFERENCE IS SPLIT AT THE FIRST TWO SLASHES ONLY, because a name can
 * contain them: `public/pages//catalog` is the page called `/catalog`.
 */
const from = (env, file, type) => (entry) => ({
	...entry,
	env,
	source: [`${env}/${file}`, type, entry.name],
	ref: `${env}/${type}/${entry.name}`
});

/** One location, as the string a `data-loc` attribute and a lookup both use. */
export const locKey = (loc) => JSON.stringify(loc ?? null);

/**
 * A name, reduced to something a URL fragment and a filename can both hold.
 *
 * `/` REDUCES TO NOTHING, and a nameless anchor is a broken one — the front
 * page falls back to `root`.
 */
export const slug = (name) =>
	String(name ?? '')
		.toLowerCase()
		.replace(/\?/g, 'maybe-')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '') || 'root';

/** The fragment an entity is linked to. Unique because a name is, within a type. */
export const anchorOf = (n) => `${n.source[1]}-${slug(n.name)}`;

/** The picture an entity was photographed into. */
export const pictureOf = (n) => `/shots/${slug(n.name)}.webp`;

/* ── The vocabularies ───────────────────────────────────────────────────── */

/** Every mark, by name. `marks.js` draws them; nothing else reads the shapes. */
export const LOGO = new Map(LOGOS.logos.map((l) => [l.name, l]));

const DATA = {
	app: { db: APP_DB, backend: APP_BACKEND, app: APP_APP, flows: APP_FLOWS },
	platform: { db: PLATFORM_DB, backend: PLATFORM_BACKEND, flows: PLATFORM_FLOWS }
};

/** A vocabulary, per environment: the services, triggers, middleware, stages. */
const vocab = (key, list) =>
	Object.fromEntries(ENVIRONMENTS.map((e) => [e.name, DATA[e.name][key]?.[list] ?? []]));

export const SERVICES = vocab('db', 'services');
export const TRIGGERS = vocab('backend', 'triggers');
export const RENDERS = vocab('website', 'renders');
export const PLATFORMS = vocab('app', 'platforms');

export const STAGES = vocab('flows', 'stages');

export const MIDDLEWARE = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].backend?.middleware ?? [])
		.map(from(e.name, 'backend.json', 'middleware'))
		.map((m) => ({ ...m, code: text(m.code) }))
);

export const middlewareBy = (env, name) =>
	MIDDLEWARE.find((m) => m.env === env && m.name === name);
export const renderBy = (env, name) => (RENDERS[env] ?? []).find((r) => r.name === name);
export const stageBy = (env, name) => (STAGES[env] ?? []).find((s) => s.name === name);

/* ── The entities ───────────────────────────────────────────────────────── */

/**
 * Shared types, declared once and referenced by name from the collections that
 * use them. `Timestamp` is Firestore's; in the Realtime Database, which has no
 * such thing, times are milliseconds since the epoch and are written `number`.
 */
export const TYPES = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].db?.types ?? [])
		.map(from(e.name, 'db.json', 'types'))
		.map((t) => ({ ...t, code: text(t.code) }))
);

/** Where every fact the shop keeps actually lives. */
export const DB = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].db?.schema ?? [])
		.map(from(e.name, 'db.json', 'schema'))
		.map((n) => ({ ...n, kind: 'db', rules: text(n.rules), schema: text(n.schema) }))
);

/**
 * Every script, whether a request reaches it or not.
 *
 * `services` are reached from outside — an address, a document changing, an
 * account being made. `proxyFunctions` are reached only by other code: a table,
 * a rule written once and read from both ends.
 */
const backendNode = (env, list) => (n) => ({
	...from(env, 'backend.json', list)(n),
	kind: 'backend',
	proxy: list === 'proxyFunctions',
	trigger: list === 'proxyFunctions' ? 'module' : n.trigger,
	middleware: n.middleware ?? null,
	wire: text(n.ioSchema),
	flow: text(n.implementation),
	uses: n.touches ?? []
});

export const BACKEND = ENVIRONMENTS.flatMap((e) => [
	...(DATA[e.name].backend?.services ?? []).map(backendNode(e.name, 'services')),
	...(DATA[e.name].backend?.proxyFunctions ?? []).map(backendNode(e.name, 'proxyFunctions'))
]);

/**
 * EVERY PICTURE, FLATTENED, because a flow step points at a SCREEN — a page or
 * an overlay in one particular state, `The six digits` rather than `the sign-in
 * window`. The staging that reaches that state lives in `shots.mjs` under the
 * same name: a recipe for a camera is not a fact about the shop.
 */
export const SCREENS = ENVIRONMENTS.flatMap((e) =>
	[...(DATA[e.name].website?.pages ?? []), ...(DATA[e.name].website?.overlay ?? [])].flatMap(
		(owner) =>
			(owner.screenshots ?? []).map((shot) => ({
				...shot,
				env: e.name,
				source: [`${e.name}/website.json`, 'screens', shot.name],
				ref: `${e.name}/screens/${shot.name}`,
				of: owner.name
			}))
	)
);

const withScreens = (n) => ({ ...n, screenshots: SCREENS.filter((s) => s.of === n.name) });

/**
 * THE APPLICATION'S PHOTOGRAPHS, WHICH ARE NOT WEBSITE SCREENS.
 *
 * They are the same idea — a named picture of one surface in one state, taken
 * by a runner and captioned by its name — and they are kept in a second list
 * because the thing they belong to is a SCREEN OF AN APP rather than a page or
 * an overlay of a website. Folding them into `SCREENS` would say that every
 * picture in this document hangs off `website.json`, which stopped being true
 * the moment the app was photographed.
 *
 * `shots` AND NOT `screens` IN THE REFERENCE, because a screen of the app
 * already owns `business/screens/<name>` and two things cannot share one.
 */
export const APP_SHOTS = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].app?.screens ?? []).flatMap((owner) =>
		(owner.screenshots ?? []).map((shot) => ({
			...shot,
			env: e.name,
			source: [`${e.name}/app.json`, 'shots', shot.name],
			ref: `${e.name}/shots/${shot.name}`,
			of: owner.name
		}))
	)
);

/** Every route the site ships. */
export const WEBSITE = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].website?.pages ?? [])
		.map(from(e.name, 'website.json', 'pages'))
		.map(withScreens)
		.map((n) => ({ ...n, kind: 'website' }))
);

/**
 * THE SURFACES THAT ARE NOT ROUTES: a drawer, a sheet, a window, a mail. A type
 * says what each is, where a sentence used to explain that it had no address.
 */
export const OVERLAYS = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].website?.overlay ?? [])
		.map(from(e.name, 'website.json', 'overlay'))
		.map(withScreens)
		.map((n) => ({ ...n, kind: 'website' }))
);

/**
 * THE APP, WHICH SHIPS THROUGH A STORE AND HAS NO WEB ADDRESSES.
 *
 * READS AND CALLS ARE KEPT APART because they are different mechanisms with
 * different failure modes. A read goes straight to Firestore and is answered by
 * the security rules from the token's claims; a call goes to an endpoint that
 * holds an invariant across several documents. Which is which is the first
 * thing somebody building a screen needs to know.
 */
export const APP = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].app?.screens ?? [])
		.map(from(e.name, 'app.json', 'screens'))
		.map((n) => ({ ...n, screenshots: APP_SHOTS.filter((s) => s.of === n.name) }))
		.map((n) => ({ ...n, kind: 'app', appKind: 'screen' }))
);

/**
 * THE PIECES DRAWN INSIDE THEM, listed after the screens for the same reason
 * the shared types come after the collections and the modules after the
 * endpoints: they are read when something above referred to one, not first.
 *
 * A screen has an address; a component has none, and that is the whole of the
 * difference between the two lists.
 */
export const COMPONENTS = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].app?.components ?? [])
		.map(from(e.name, 'app.json', 'components'))
		.map((n) => ({ ...n, kind: 'app', appKind: 'component' }))
);

/** The journeys, which are the only place the rest are bound together. */
export const FLOWS = ENVIRONMENTS.flatMap((e) =>
	(DATA[e.name].flows?.flows ?? [])
		.map(from(e.name, 'flows.json', 'flows'))
		.map((n) => ({ ...n, kind: 'flow' }))
);

export const ALL = [...DB, ...BACKEND, ...WEBSITE, ...OVERLAYS, ...APP, ...COMPONENTS, ...FLOWS];

/** What an `env/type/name` reference points at, or nothing. */
export const byRef = (ref) => ALL.find((n) => n.ref === ref);

/**
 * The screen a flow step names.
 *
 * EITHER SIDE'S, because a business flow's steps happen on the counter screens
 * and those are photographed now too. A step names a picture; which file the
 * picture was declared in is not something the step should have to know.
 */
export const screenOf = (ref) =>
	ref ? [...SCREENS, ...APP_SHOTS].find((s) => s.ref === ref) : undefined;

/**
 * Everything with a photograph.
 *
 * TWO RUNNERS WALK THIS, AND EACH TAKES ONLY ITS OWN HALF — `shots.mjs` drives
 * the website, `app-shots.mjs` drives the application. What they BOTH need the
 * whole list for is the sweep at the end: a file in `shots/` that no longer
 * belongs to any screen is deleted, and a runner that knew about only its own
 * half would delete the other's pictures every time it ran.
 */
export const PHOTOGRAPHED = [...SCREENS, ...APP_SHOTS];

/** Everything that can carry a note, and everything a link can point at. */
export const MARKABLE = [...ALL, ...TYPES, ...MIDDLEWARE];

/** The entity a location names, or nothing when it has been renamed away. */
export const atLocation = (loc) => MARKABLE.find((n) => locKey(n.source) === locKey(loc));

/** Everything markable, by the anchor its card carries. */
export const atAnchor = (env, hash) =>
	MARKABLE.find((n) => n.env === env && anchorOf(n) === hash) ??
	MARKABLE.find((n) => anchorOf(n) === hash);

/** Which page an entity's card is rendered on. */
export const homeOf = (n) =>
	n.kind ? pageOf(n.env, n.kind) : pageOf(n.env, n.source[1] === 'middleware' ? 'backend' : 'db');

/**
 * Every connection, derived from what each node says it uses.
 *
 * Flows declare theirs inside their steps rather than at the top, because a
 * flow's whole content IS its sequence — a separate list would be a second
 * place to forget.
 */
export function edges() {
	const out = [];
	for (const node of ALL) {
		for (const to of node.uses ?? []) if (byRef(to)) out.push({ from: node.ref, to });
		for (const step of node.steps ?? []) {
			for (const to of step.uses ?? []) {
				if (byRef(to) && !out.some((e) => e.from === node.ref && e.to === to)) {
					out.push({ from: node.ref, to });
				}
			}
		}
	}
	return out;
}

/** Who points at this. Derived, never declared — see the note at the top. */
export const usedBy = (ref) => edges().filter((e) => e.to === ref).map((e) => byRef(e.from));
