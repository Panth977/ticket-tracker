import {
	ALL,
	ENVIRONMENTS,
	KINDS,
	MIDDLEWARE,
	RENDERS,
	TYPES,
	anchorOf,
	byRef,
	locKey,
	COMPONENTS,
	middlewareBy,
	homeOf,
	pageOf,
	pictureOf,
	renderBy,
	stageBy,
	screenOf,
	usedBy
} from './model.js';
import { markFor } from './marks.js';

/**
 * Every page on this site, drawn from the model.
 *
 * EIGHT PAGES, ONE RENDERER — four kinds across two environments, each a
 * different slice of the same data. Writing them separately would mean eight
 * places for a cross-link to rot.
 */

/**
 * A link to any entity, wherever it lives.
 *
 * THE ENVIRONMENT IS PART OF THE ADDRESS, and a link can cross: a business flow
 * names the orders collection, which is described on the public side, because
 * there is one collection and two systems reading it.
 *
 * The reference carries the type as well as the name, because a name is unique
 * only inside its own list — `orders` is a collection and `/orders` is a page.
 */
export function link(ref) {
	const node = byRef(ref);
	if (!node) return esc(ref);
	return `<a class="xref xref--${node.kind}" href="${homeOf(node)}#${anchorOf(node)}">${esc(node.name)}</a>`;
}

/**
 * WHERE THIS CARD'S FACTS LIVE IN THE JSON, stamped on the element.
 *
 * It is what a margin note is pinned to. A note used to carry a CSS path and
 * the words the element read as, both properties of a RENDERING — so rewriting
 * the card, which is the entire loop this document exists for, left the note
 * homeless. The entity's coordinates do not change when its prose does.
 */
const loc = (n) => (n.source ? ` data-loc="${esc(locKey(n.source))}"` : '');

export const esc = (s) =>
	String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * TWO BARS: which system, then which page of it.
 *
 * THE MASTHEAD IS GONE. It spent the top third of every screen on a wordmark, a
 * one-word title and a sentence restating the tab underneath it — on a document
 * whose whole content begins below the fold. The tabs say where you are, and a
 * page that has to introduce itself before it says anything is a page that has
 * not started.
 *
 * THE ENVIRONMENT COMES FIRST because it is the bigger choice: `public` and
 * `business` are different systems that happen to share a database, and a
 * reader is in one or the other. The pages of the one you are in come second,
 * and they differ — the public side has a website, the business side an app.
 */
/*
 * MIGRATION SITS BESIDE THE ENVIRONMENTS AND IS NOT ONE. Everything under
 * /public and /business is a VIEW of the files in docs/data — the same entities
 * drawn as cards and cross-linked. A migration is not an entity: it is an
 * argument about two systems, with tables of what maps to what and what was
 * lost, so it is four written pages rather than a third environment.
 *
 * IT IS STILL IN THIS RAIL AND DRESSED AS A PEER, because a reader who cannot
 * reach it from the specification will not find it at all — and the question it
 * answers, where the shop's 2022 data goes, is one somebody has while reading
 * these pages. Its own pages carry a copy of this same chrome, so moving
 * between the three reads as one document rather than as a document and an
 * appendix.
 *
 * AND THIS NOTE IS HERE RATHER THAN BESIDE THE LINK. Everything returned below
 * is ONE TEMPLATE LITERAL, so an HTML comment inside it is still JavaScript: a
 * backtick in the prose ends the string and takes the whole document down. That
 * is how this file was broken — the page went blank and the console said
 * "Unexpected identifier", pointing at the word after the quote rather than at
 * the quote. Prose about this file goes outside the string it describes.
 */
export function chrome(env, kind) {
	const here = ENVIRONMENTS.find((e) => e.name === env);
	document.title = `${KINDS[kind].label} · ${here.label} · TaskManager`;
	return `
    <header class="chrome">
      <nav class="chrome__envs" aria-label="Environment">
        ${ENVIRONMENTS.map(
					(e) =>
						`<a href="${pageOf(e.name, e.kinds[0])}" class="${e.name === env ? 'on' : ''}"
					     title="${esc(e.note)}">${esc(e.label)}</a>`
				).join('')}
        <a href="/plan/architecture" class=""
           title="The argument: architecture, decisions, and the order it gets built in.">Plan</a>
      </nav>
      <nav class="chrome__pages" aria-label="Page">
        ${here.kinds
					.map(
						(k) =>
							`<a href="${pageOf(env, k)}" class="${k === kind ? 'on' : ''}">${KINDS[k].label}</a>`
					)
					.join('')}
      </nav>
    </header>`;
}

/**
 * Who else points at this — derived, so it can never be stale, and GROUPED BY
 * WHAT THEY ARE.
 *
 * One run of links answered "what touches this" and left the reader to work out
 * which of them were scripts and which were screens. That is the first question
 * anybody asks of a table: is this reached from a server or from a browser? So
 * the backend, the website and the flows are named separately, and a group with
 * nothing in it is absent rather than empty.
 *
 * Anything this node itself names is left out. A website page declares the flow
 * it belongs to and that flow's steps name the page back — both worth
 * declaring, and said twice on one card it reads as a bug in the document.
 */
function backlinks(node) {
	const already = new Set(node.uses ?? []);
	const from = usedBy(node.ref).filter((n) => !already.has(n.ref));
	if (!from.length) return '';

	const groups = [
		['Used by backend', from.filter((n) => n.kind === 'backend')],
		['Used by screens', from.filter((n) => n.kind === 'app')],
		['Used by flows', from.filter((n) => n.kind === 'flow')],
		['Used by DB', from.filter((n) => n.kind === 'db')]
	];

	return groups
		.filter(([, list]) => list.length)
		.map(
			([label, list]) =>
				`<p class="usedby"><span>${label}</span> ${list.map((n) => link(n.ref)).join(' ')}</p>`
		)
		.join('');
}

function forwardlinks(node) {
	const to = (node.uses ?? []).filter(byRef);
	if (!to.length) return '';
	return `<p class="usedby"><span>Touches</span> ${to.map(link).join(' ')}</p>`;
}

/**
 * A fact worth stopping on.
 *
 * THREE SHAPES, AND PROSE IS THE WEAKEST OF THEM. These notes started as a
 * sentence and grew into essays — one of them ran to two hundred words about
 * which field lives where, which is a question with a shape, and a shape reads
 * as a table or as five lines of pseudo-code far better than as a paragraph
 * somebody has to hold in their head to the end of.
 *
 * So `body` is the reason, kept short, and the thing being explained goes in
 * `table` when it is "what goes where" and in `code` when it is "what happens,
 * in order". A note may carry either, and the body is what says why it matters.
 */
function noteOf(node) {
	const n = node.note;
	if (!n) return '';

	const table = n.table
		? `<div class="scroller"><table class="note__rows">
        <thead><tr>${n.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${n.table.rows
					.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
					.join('')}</tbody>
      </table></div>`
		: '';

	const code = n.code ? `<pre class="note__code">${esc(n.code.trim())}</pre>` : '';

	return `<div class="note">
    <b>${esc(n.title)}</b>
    ${n.body ? `<p class="note__why">${esc(n.body)}</p>` : ''}
    ${code}${table}
  </div>`;
}

/*
 * THE SHARED TABLE HELPER IS GONE. Both pages that used it — the collections
 * and the endpoints — say what they have to say as declarations now: an
 * interface for a shape, pseudo-code for a sequence. A field/type/note table
 * loses optionality, unions, nesting and status codes, and translates a thing
 * every reader of this page can already read into something they cannot check.
 *
 * A note may still carry one, for the "what goes where" case a shape cannot
 * express. That one lives in `noteOf`.
 */

/* ── One node, on its own index page ───────────────────────────────────── */

/**
 * A declared type, wherever its name appears in a listing.
 *
 * THE POINT OF NAMING A TYPE IS BEING ABLE TO GO AND READ IT. `Address`
 * appears in the profile, in an order and in the shared list; written out three
 * times they disagree within a month, and written once with no way to reach it
 * the reader has to go looking. So every occurrence of a declared name becomes
 * a link to the declaration.
 *
 * MATCHED ON A WORD BOUNDARY and skipping the line that declares it, or the
 * heading of `interface Address` would link to itself. Escaping happens FIRST
 * and the anchors are inserted after, because doing it the other way round
 * would escape the markup this adds.
 */
/**
 * WHAT A WORD IS, in the two dialects these blocks hold.
 *
 * TypeScript interfaces and the pseudo-code of a rules file or a handler sit in
 * the same document and are read one after the other, so they share one set. No
 * word here means something different on the two sides.
 *
 * BUILTINS ARE SEPARATED FROM KEYWORDS because they answer different questions.
 * `interface` and `allow` say what KIND of statement this is; `string` and
 * `Timestamp` say what a value IS. Colouring them alike makes a schema one
 * undifferentiated block, which is the state this was asked to fix.
 */
const KEYWORD =
	'interface|type|function|const|let|return|throw|new|await|async|' +
	'if|else|for|each|of|in|is|extends|as|' +
	'allow|match|read|write|get|list|create|update|delete|never|rules_version|service';

const BUILTIN =
	'string|number|boolean|bigint|symbol|object|void|any|unknown|' +
	'true|false|null|undefined|Timestamp|Record|Array|Promise|Map|Set|Date|' +
	'map|timestamp|path|latlng';

/**
 * Colour the code, and link the types, in ONE PASS.
 *
 * WHY ONE PASS AND NOT TWO. Highlighting after linking would colour the markup
 * the linking inserted; linking after highlighting would put an anchor inside a
 * comment span. Walking the text once and deciding what each token IS settles
 * the precedence properly — and gives the thing that matters most: a type named
 * inside a comment stays a comment rather than becoming a link in the middle of
 * a sentence.
 *
 * THE ORDER OF THE GROUPS IS THE PRECEDENCE. A comment swallows its line
 * whatever is in it; a string swallows its quotes; a declared type beats the
 * general word rules, because `Branch` is a link and `boolean` is not.
 *
 * ESCAPED FIRST, so the tokeniser works on exactly what will be rendered. That
 * is also why the operators are written as their entities — by this point `&&`
 * is `&amp;&amp;`, and a regex looking for a bare `&` would cut an entity in
 * half and put a span inside it.
 */
/**
 * IS THIS PARAGRAPH CODE, OR IS IT ENGLISH?
 *
 * These blocks are not all code. A `What happens` listing is pseudo-code with
 * paragraphs of prose between the steps — the reasoning that belongs beside the
 * sequence — and those paragraphs carry ordinary words: `is`, `function`, `2`.
 * Tokenising them lit three words in an English sentence and left the rest, so
 * the eye was drawn to whichever words happened to be reserved. That is worse
 * than no colour, because it is colour that means nothing.
 *
 * SO THE UNIT IS A PARAGRAPH, not a line and not the whole block. A paragraph
 * whose lines mostly carry no code punctuation is prose, and prose recedes
 * exactly as a comment does — which is what it is.
 *
 * A THIRD IS THE THRESHOLD, and it is deliberately generous. Prose here quotes
 * paths and field names constantly, so demanding NO punctuation would call half
 * of it code; requiring most lines to carry some is what actually separates a
 * sequence of steps from a sentence about them.
 */
const CODEY = /[(){}[\]=|:'→←]/;

function isProse(paragraph) {
	/* A line beginning `//` is a comment either way; it does not vote. */
	const voting = paragraph
		.split('\n')
		.filter((l) => l.trim() && !l.trim().startsWith('//'));
	if (!voting.length) return false;
	return voting.filter((l) => CODEY.test(l)).length / voting.length < 1 / 3;
}

/**
 * Colour the code, and link the types, in ONE PASS.
 *
 * WHY ONE PASS AND NOT TWO. Highlighting after linking would colour the markup
 * the linking inserted; linking after highlighting would put an anchor inside a
 * comment span. Walking the text once and deciding what each token IS settles
 * the precedence properly — and gives the thing that matters most: a type named
 * inside a comment stays a comment rather than becoming a link in the middle of
 * a sentence.
 *
 * THE ORDER OF THE GROUPS IS THE PRECEDENCE. A comment swallows its line
 * whatever is in it; a string swallows its quotes; a declared type beats the
 * general word rules, because `Branch` is a link and `boolean` is not.
 *
 * ESCAPED FIRST, so the tokeniser works on exactly what will be rendered. That
 * is also why the operators are written as their entities — by this point `&&`
 * is `&amp;&amp;`, and a regex looking for a bare `&` would cut an entity in
 * half and put a span inside it.
 */
function highlight(code, selfName, env = 'public') {
	const names = TYPES.filter((t) => t.env === env)
		.map((t) => t.name)
		.filter((name) => name !== selfName);

	const parts = [
		'(?<comment>\\/\\/[^\\n]*)',
		"(?<string>'[^'\\n]*')",
		names.length ? `(?<type>\\b(?:${names.join('|')})\\b)` : null,
		`(?<key>\\b(?:${KEYWORD})\\b)`,
		`(?<builtin>\\b(?:${BUILTIN})\\b)`,
		/* A name with a `(` after it is being called, whatever else it is. */
		'(?<call>\\b[A-Za-z_$][\\w$]*(?=\\())',
		'(?<num>\\b\\d+(?:[_.]\\d+)*\\b)',
		/* The punctuation that carries meaning: a union, an arrow, an optional
		   marker, a comparison. Braces and commas stay in the ordinary ink. */
		'(?<op>=&gt;|-&gt;|→|&amp;&amp;|\\|\\||[=!]==?|&lt;=?|&gt;=?|≤|≥|\\?|\\|)'
	].filter(Boolean);

	const token = new RegExp(parts.join('|'), 'g');

	const paint = (text) =>
		text.replace(token, (match, ...rest) => {
			const g = rest[rest.length - 1];
			if (g.comment) return `<i class="hl-note">${match}</i>`;
			if (g.string) return `<span class="hl-str">${match}</span>`;
			if (g.type) {
				const type = TYPES.find((t) => t.env === env && t.name === match);
				/*
				 * THE FULL ADDRESS, not a bare fragment. The types are declared on the
				 * DB page and referenced from every other one: `Touch` appears in
				 * `attribution`'s wire on the Backend page, where `#types-touch` is an
				 * anchor that does not exist and a click did nothing at all.
				 */
				return `<a class="xref xref--type" href="${homeOf(type)}#${anchorOf(type)}">${match}</a>`;
			}
			if (g.key) return `<span class="hl-key">${match}</span>`;
			if (g.builtin) return `<span class="hl-type">${match}</span>`;
			if (g.call) return `<span class="hl-call">${match}</span>`;
			if (g.num) return `<span class="hl-num">${match}</span>`;
			return `<span class="hl-op">${match}</span>`;
		});

	/* Split on blank lines, KEEPING them, so the block comes back the shape it
	   went in — these listings are aligned by hand and a lost line moves them. */
	return esc(code)
		.split(/(\n[ \t]*\n)/)
		.map((chunk) =>
			/^\n[ \t]*\n$/.test(chunk) || !isProse(chunk)
				? paint(chunk)
				: `<i class="hl-note">${chunk}</i>`
		)
		.join('');
}

/**
 * A block of declarations, or of rules.
 *
 * WRITTEN AS CODE BECAUSE IT IS CODE. This page used to describe a document
 * with a three-column table of field, type and note, and a paragraph beside it
 * saying who could read it — which is a translation of a thing everybody
 * reading this page can already read, into a form that loses optionality,
 * nesting, unions and defaults. An interface says all of that and says it in
 * the language the code is written in.
 */
const block = (label, code, selfName, env) => `
  <div class="decl">
    <span class="decl__label">${esc(label)}</span>
    <pre class="decl__code">${highlight(code, selfName, env)}</pre>
  </div>`;

/**
 * A pair of labelled facts, rather than one string with a dot in it.
 *
 * `Realtime Database · auth-monitor/blocks/{hash}` said both of these at once
 * and a reader scanning the page for "what is in Firestore" had to parse each
 * one. Which SERVICE holds a thing decides what can be done to it — rules or a
 * different rules file, a document limit or none, a TTL policy or a sweep — and
 * it is worth being able to see down a column.
 */
/*
 * A PROJECT ROW ONLY WHERE THERE IS SOMETHING TO SAY.
 *
 * Everything else on this page sits in the one Firebase project, so naming it
 * on every card would be a row of identical noise. The collection that does not
 * is the single card a reader must not skim — `backend/firestore.rules` has no
 * authority over it, and nothing in this repository can be changed to gain any.
 */
const where = (service, location, project) => `
  <dl class="where">
    <dt>Service</dt><dd>${marked(service)}</dd>
    ${project ? `<dt>Project</dt><dd><code>${esc(project)}</code></dd>` : ''}
    <dt>Location</dt><dd><code>${esc(location)}</code></dd>
  </dl>`;

function dbCard(n) {
	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      ${where(n.service, n.location, n.project)}
      ${block('Rules', n.rules, null, n.env)}
      ${block('Schema', n.schema, null, n.env)}
      ${forwardlinks(n)}${backlinks(n)}
    </section>`;
}

/** One shared type, on the same page as the collections that use it. */
function typeCard(t) {
	return `
    <section class="block block--type" id="${anchorOf(t)}"${loc(t)}>
      <h2>${esc(t.name)}</h2>
      ${block('Type', t.code, t.name, t.env)}
    </section>`;
}

/**
 * The middleware in front of an endpoint, as a word rather than a sentence.
 *
 * Beside the path because it is part of the address in every sense that
 * matters: it says what has to be true to knock. Nodes that are not endpoints —
 * a trigger, a table, a module — carry none and get nothing.
 *
 * IT LINKS TO WHAT IT MEANS, and the colour comes from `backend.json` rather
 * than from a rule in the stylesheet: adding a fourth middleware should be an
 * entry in a list, not an entry in a list and a colour somebody has to remember
 * to add three files away.
 */
function authOf(n) {
	const found = middlewareBy(n.env, n.middleware);
	if (!found) return '';
	const paint = `color:${found.color};background:color-mix(in srgb, ${found.color} 8%, transparent)`;
	return `<a class="badge badge--mw" style="${paint}" href="#${anchorOf(found)}">${esc(found.name)}</a>`;
}

/**
 * An id from a name that may have a `?` in it.
 *
 * `?` BECOMES A WORD RATHER THAN BEING DROPPED. Stripping punctuation turned
 * `?auth` into `auth` — the same anchor the `auth` middleware already had, so
 * the page carried two elements with one id and the `?auth` badge linked to the
 * wrong card. The one character that distinguishes them was the one being
 * thrown away.
 */
const slug = (name) =>
	name
		.replace(/\?/g, 'maybe-')
		.replace(/[^a-z0-9]+/gi, '-')
		.replace(/^-|-$/g, '') || 'x';

/**
 * WHAT A MIDDLEWARE ACTUALLY DOES, once, at the foot of the page it governs.
 *
 * The badge says which of the three an endpoint carries and cannot say what
 * that means — and `?auth` against `auth` is the difference between "a caller
 * may be absent" and "a caller may be wrong". Written out per endpoint it would
 * be eleven copies of the same paragraph; written nowhere, the badge is a word
 * the reader has to already know.
 */
function middlewareCard(m) {
	const paint = `color:${m.color};background:color-mix(in srgb, ${m.color} 8%, transparent)`;
	return `
    <section class="block block--type" id="${anchorOf(m)}"${loc(m)}>
      <h2><span class="badge badge--mw" style="${paint}">${esc(m.name)}</span></h2>
      <p class="lede">${esc(m.note)}</p>
      ${block('What it does', m.code, null, m.env)}
    </section>`;
}

/** A service, with its own mark in front of it. */
const marked = (name) => `<span class="marked">${markFor(name)}${esc(name)}</span>`;

/**
 * HOW A SCRIPT IS REACHED, which is the thing the page used to leave implicit.
 *
 * The trigger is a mark and a word — `api`, `firestore`, `auth`, `module` —
 * because what runs a script is the first thing to know about it: an address
 * somebody calls, a document changing under it, an account being made, or
 * nothing at all. `onSessionDeleted` sat on a page called Endpoints and is not
 * one, which is how a reader ends up looking for a URL that was never going to
 * exist.
 *
 * A BADGE BESIDE THE MARK SAID THE SAME WORD TWICE. The mark carries the word
 * already; a pill repeating it is decoration with a colour on it.
 */
const reached = (n) => `
  <dl class="where">
    <dt>Trigger</dt><dd>${marked(n.trigger)}</dd>
    <dt>Reached by</dt><dd><code>${esc(n.location)}</code>${authOf(n)}</dd>
  </dl>`;

function backendCard(n) {
	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      ${reached(n)}
      ${block('In and out', n.wire, null, n.env)}
      ${block('What happens', n.flow, null, n.env)}
      ${forwardlinks(n)}${backlinks(n)}
    </section>`;
}

/**
 * A photograph of the page, taken by `shots.mjs`.
 *
 * SIGNED OUT, ALWAYS, and that is deliberate rather than a shortcoming — see
 * the note in that file. `/admin` and `/orders` would otherwise put a real
 * customer's name, number and address into the repository.
 *
 * STILL A LINK TO THE FILE, and `lightbox.js` intercepts the click. The link
 * is what makes the picture reachable with a keyboard, openable in a tab by
 * anybody who wants one, and legible if the script never loads; the lightbox
 * is what happens on an ordinary click. The argument that used to be here —
 * that a plain link is enough, because a browser already knows how to show an
 * image — is answered in that file: it leaves the document, and it was
 * downloading the file rather than showing it.
 */
/**
 * A photograph of a screen.
 *
 * IT TAKES A SCREENSHOT, NOT A PAGE. A page has several — the confirm page is
 * photographed asking, approved and declined — so the picture is the thing with
 * a name and a location, and the page merely lists them.
 *
 * THE CAPTION IS THE SCREEN'S NAME, not a paragraph about how it was staged.
 * A drawer, a sheet, the third step of a form: none of them have an address,
 * and `The six digits` says which picture this is in three words. What was
 * clicked to reach it is a recipe for a camera and lives in `shots.mjs`.
 */
/**
 * AND A SENTENCE AFTER IT, WHERE THE PICTURE NEEDS ONE.
 *
 * The website's screenshots do not: the shop is open, so what is in the picture
 * is simply what is there. The application's are of a shop nobody has set up
 * yet — an account with no counter, a catalogue with five stand-ins in it — and
 * a reader looking at `No counter is chosen` has no way to tell a first-day
 * state from a broken screen. `note` is where the picture says which it is.
 */
function shotOf(n, cls = 'shot', { plain = false } = {}) {
	if (!n?.name) return '';
	const said = n.note ? `${esc(n.name)} — ${esc(n.note)}` : esc(n.name);
	const caption = n.of ? `<figcaption class="shot__staged">${said}</figcaption>` : '';
	const img = `
      <img src="${pictureOf(n)}" alt="${esc(n.name)} as it looks now"
           loading="lazy" width="1100" height="688">`;
	/*
	 * NOT A LINK IN A PREVIEW. The lightbox walks every picture on the page with
	 * ← and →, and a copy of one inside a hover card would put the same
	 * screenshot in that walk twice — and open a modal from a card that
	 * disappears the moment the pointer leaves it.
	 */
	return `
    <figure class="${cls}">
      ${plain ? img : `<a href="${pictureOf(n)}" target="_blank" rel="noopener">${img}</a>`}
      ${caption}
    </figure>`;
}

/**
 * HOW A PAGE IS SERVED, as a coloured word rather than a sentence.
 *
 * `SSR`, `Prerendered`, `Client only` — the same shape as the middleware badge
 * on the Backend page, and for the same reason: the question a reader has of an
 * enum is which of these are the same, and a colour answers that by being
 * looked at.
 */
function renderBadge(env, name) {
	const found = renderBy(env, name);
	if (!found) return esc(name ?? '');
	const paint = `color:${found.color};background:color-mix(in srgb, ${found.color} 8%, transparent)`;
	return `<span class="badge badge--mw" style="${paint}">${esc(found.name)}</span>`;
}

/**
 * WHERE A STEP HAPPENS — the browser, the server, WhatsApp, an inbox, or the
 * shop's own counter screens.
 *
 * A step with no picture is not an unfinished step: an order being written and
 * a message arriving in WhatsApp are not screens and there is nothing to
 * photograph. The stage is what those steps have instead, and the mark makes it
 * readable down a column the way the service marks are on the DB page.
 */
function stage(env, name) {
	const found = stageBy(env, name);
	if (!found) return '';
	return `<span class="flow__stage">${markFor(found.logo)}${esc(found.name)}</span>`;
}

/** Every picture a page or an overlay was photographed in. */
const shotsOf = (n, opts) =>
	(n.screenshots ?? []).map((shot) => shotOf(shot, 'shot', opts)).join('');

/** The overlays a page carries — a drawer, a sheet, a window. */
function carries(n) {
	const list = (n.componentNames ?? []).map((name) => byRef(`${n.env}/overlay/${name}`)).filter(Boolean);
	if (!list.length) return '';
	return `<p class="usedby"><span>Shows</span> ${list.map((o) => link(o.ref)).join(' ')}</p>`;
}

function pageCard(n) {
	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      <dl class="where">
        <dt>Rendered</dt><dd>${renderBadge(n.env, n.renderName)}</dd>
        ${n.location ? `<dt>Location</dt><dd><code>${esc(n.location)}</code></dd>` : ''}
      </dl>
      ${shotsOf(n)}
      ${carries(n)}${forwardlinks(n)}${backlinks(n)}
    </section>`;
}

/**
 * A SURFACE WITH NO ADDRESS: a drawer, a sheet, a window, a mail.
 *
 * It used to be a page whose `path` was a sentence saying it was not one —
 * "A sheet, not a route". A type says it in a word, and says it the same way
 * every time.
 */
function overlayCard(n) {
	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      <dl class="where">
        <dt>Kind</dt><dd><code>${esc(n.type)}</code></dd>
      </dl>
      ${shotsOf(n)}
      ${forwardlinks(n)}${backlinks(n)}
    </section>`;
}

function flowSteps(n, preview = false) {
	return `
      <ol class="flow">
        ${n.steps
					.map(({ name, where, uses, screen }) => {
						/*
						 * THE SCREEN THIS STEP HAPPENS ON, NAMED BY THE STEP.
						 *
						 * It used to be inferred — the first thing the step touched that
						 * happened to have a photograph — on the reasoning that a step
						 * already lists what it touches and a second list would be a
						 * second thing to keep true. The reasoning was fine and the
						 * result was that almost no step had a picture: what a step
						 * touches is mostly collections and endpoints, and none of those
						 * are photographable. The two that did get one got it by accident
						 * of ordering.
						 *
						 * A step that happens nowhere on a screen — a write, a message
						 * arriving in WhatsApp, a rider at a door — says so by naming
						 * nothing, which is a different thing from having been forgotten.
						 */
						const seen = preview ? null : screenOf(screen);
						return `
          <li>
            <b>${esc(name)}</b>${stage(n.env, where)}
            ${uses?.length ? `<span class="flow__refs">${uses.map(link).join(' ')}</span>` : ''}
            ${seen ? shotOf(seen, 'shot shot--step') : ''}
          </li>`;
					})
					.join('')}
      </ol>`;
}

function flowCard(n) {
	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      ${flowSteps(n)}
      ${backlinks(n)}
    </section>`;
}

/**
 * THE SAME CARD, FOR THE HOVER PREVIEW — the real one, not a description of it.
 *
 * It was a monospace card holding whatever text the kind happened to have, so a
 * page previewed as a paragraph of plain text while its listing on the page is
 * a paragraph AND a photograph of the screen. A preview that leaves out the
 * picture is answering a different question from the one the reader asked.
 *
 * WHAT IS LEFT OUT, AND WHY ONLY THIS:
 *
 *   THE NAME — it is the link the reader is pointing at. Repeating it spends
 *     the top of the card saying the word already under the cursor.
 *   THE SECTION AND ITS `id` — two elements on one page with one id, and an
 *     anchor a reader clicks would land on whichever the browser found first.
 *   WHO USES IT — a wall of cross-links inside a card that exists to save a
 *     jump, offering more jumps. The card underneath has them.
 *   A FLOW'S STEP PICTURES — eight screenshots is not a preview.
 */
export function previewFor(node) {
	if (node.kind === 'db') {
		return (
			where(node.service, node.location) +
			block('Rules', node.rules, null, node.env) +
			block('Schema', node.schema, null, node.env)
		);
	}
	if (node.kind === 'backend') {
		return (
			reached(node) +
			block('In and out', node.wire, null, node.env) +
			block('What happens', node.flow, null, node.env)
		);
	}
	if (node.kind === 'website') {
		const head = node.type
			? `<dl class="where"><dt>Kind</dt><dd><code>${esc(node.type)}</code></dd></dl>`
			: `<dl class="where">
          <dt>Rendered</dt><dd>${renderBadge(node.env, node.renderName)}</dd>
          ${node.location ? `<dt>Location</dt><dd><code>${esc(node.location)}</code></dd>` : ''}
        </dl>`;
		return head + shotsOf(node, { plain: true });
	}
	/*
	 * A SCREEN OF THE APPLICATION: its address, and what it looks like.
	 *
	 * WITHOUT THIS IT FELL THROUGH TO THE LINE BELOW and previewed as a
	 * photograph named after the SCREEN rather than after any picture that was
	 * taken — an `<img>` pointing at a file that has never existed, which a
	 * browser draws as a broken image inside a card that vanishes when the
	 * pointer leaves. The wireframe is left out for the same reason a flow's
	 * step pictures are: it is the biggest thing on the card and the reader
	 * asked a question they wanted answered without leaving where they were.
	 */
	if (node.kind === 'app') {
		return (
			`<dl class="where">
          <dt>Kind</dt><dd><code>${esc(node.appKind)}</code></dd>
          ${node.route ? `<dt>Route</dt><dd><code>${esc(node.route)}</code></dd>` : ''}
        </dl>` + shotsOf(node, { plain: true })
		);
	}
	if (node.kind === 'flow') return flowSteps(node, true);
	/* A screen: the picture is the whole of what it is. */
	return shotOf(node, 'shot', { plain: true });
}

/** A shared type, previewed as the declaration it is. */
export const previewType = (t) => block('Type', t.code, t.name, t.env);

/** A middleware, previewed as its sentence and its pseudo-code. */
export const previewMiddleware = (m) =>
	`<p class="lede">${esc(m.note)}</p>` + block('What it does', m.code, null, m.env);

/**
 * A WIREFRAME, DRAWN FROM THE SCREEN'S OWN SPEC.
 *
 * NOT A PICTURE OF ANYTHING, AND IT KEEPS ITS PLACE NOW THERE IS ONE. The
 * photograph above it says what the screen IS today — an empty shop, a shell
 * being rebuilt, whatever was true the morning it was taken. This says what the
 * screen is FOR, which is the decision the specification is actually recording
 * and the thing a screen can drift away from. A mockup pasted in as an image
 * would do neither: it is a drawing of an intention that stops being true the
 * moment the screen is built and nobody re-exports it.
 *
 * SO IT IS RENDERED, LIKE EVERYTHING ELSE HERE. Each screen carries a short
 * list of blocks — a bar, a table with these columns, a form with these fields
 * — and this turns them into boxes. Changing what a screen holds changes the
 * wireframe in the same edit, because they are the same edit.
 *
 * IT IS DELIBERATELY CRUDE. Grey boxes and rules, no colour, no real words
 * beyond the labels the spec gives: enough to see that Sell is a picker beside
 * a bill and Reports is a table with a push above it, and not enough to be
 * mistaken for a design. The layout is the decision being recorded; the
 * typeface is not.
 */
const WIRE = {
	bar: (v) => `<div class="wf-bar">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`,
	chips: (v) => `<div class="wf-chips">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`,
	nav: (v) => `<div class="wf-nav">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`,
	menu: (v) => `<div class="wf-menu">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`,
	actions: (v) => `<div class="wf-actions">${v.map((x) => `<b>${esc(x)}</b>`).join('')}</div>`,
	tiles: (v) => `<div class="wf-tiles">${v.map((x) => `<div><span>${esc(x)}</span><i></i></div>`).join('')}</div>`,
	totals: (v) =>
		`<div class="wf-totals">${v.map((x) => `<div><span>${esc(x)}</span><i></i></div>`).join('')}</div>`,
	table: (v) => `
    <div class="wf-table">
      <div class="wf-tr wf-th">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      ${[0, 1, 2].map(() => `<div class="wf-tr">${v.map(() => '<i></i>').join('')}</div>`).join('')}
    </div>`,
	form: (v) => `
    <div class="wf-form">
      ${v.map((x) => `<label>${esc(x)}</label><i></i>`).join('')}
    </div>`,
	list: (n) => `<div class="wf-list">${Array.from({ length: n }, () => '<i></i>').join('')}</div>`,
	timeline: (v) => `
    <ol class="wf-time">
      ${v.map((x) => `<li><b>${esc(x)}</b><i></i></li>`).join('')}
    </ol>`,
	note: (v) => `<p class="wf-note">${esc(v)}</p>`
};

function wireBlock(block) {
	const [key, value] = Object.entries(block)[0];
	if (key === 'panel') {
		const lines = Number(block.lines ?? 0);
		return `<div class="wf-panel"><b>${esc(value)}</b>${Array.from({ length: lines }, () => '<i></i>').join('')}</div>`;
	}
	if (key === 'lines') return '';
	if (key === 'split') {
		return `<div class="wf-split">${value
			.map((col) => `<div>${col.map(wireBlock).join('')}</div>`)
			.join('')}</div>`;
	}
	return WIRE[key] ? WIRE[key](value) : '';
}

function wireframe(n) {
	const w = n.wire;
	if (!w) return '';
	const body = (w.blocks ?? []).map(wireBlock).join('');
	/* THE SHELL IS DRAWN AROUND IT rather than repeated inside every screen —
	   which is what the Shell component IS, said once and shown everywhere. */
	const inner = w.shell
		? `<div class="wf-shell">
         <div class="wf-side">${WIRE.nav(['Panth ▾', '⌘K', 'Inbox', 'My work', '— Boards', 'ENG ▾', 'OPS', '+ New board'])}</div>
         <div class="wf-main">
           <div class="wf-top"><span>${esc(n.name)}</span><span>🔔 Mine ▾</span></div>
           ${body}
         </div>
       </div>`
		: `<div class="wf-loose">${body}</div>`;
	return `<figure class="wf">${inner}<figcaption>${esc(n.name)} — a wireframe, not a photograph</figcaption></figure>`;
}

/**
 * A SCREEN OF THE APP, or a piece drawn inside one.
 *
 * WHERE ITS DATA COMES FROM IS THE WHOLE CARD. Two lists, kept apart because
 * they are two mechanisms with two failure modes: a READ goes straight to
 * Firestore and is answered by the rules from the token's claims, and a CALL
 * goes to an endpoint that holds an invariant across documents no rule could.
 * Somebody building a screen needs to know which of the two a thing is before
 * they know anything else about it.
 */
function appCard(n) {
	/* A screen has an address and a component has none; the badge is the fastest
	   way to tell which of the two a card is without reading the row below. */
	const colour = n.route ? '#b26a0c' : '#0f766e';
	const paint = `color:${colour};background:color-mix(in srgb, ${colour} 8%, transparent)`;
	const group = (label, refs) =>
		refs?.length
			? `<p class="usedby"><span>${label}</span> ${refs.map(link).join(' ')}</p>`
			: '';
	const inside = (n.components ?? [])
		.map((name) => byRef(`${n.env}/components/${name}`))
		.filter(Boolean);

	return `
    <section class="block" id="${anchorOf(n)}"${loc(n)}>
      <h2>${esc(n.name)}</h2>
      <dl class="where">
        <dt>Kind</dt><dd><span class="badge badge--mw" style="${paint}">${esc(n.appKind)}</span></dd>
        ${n.route ? `<dt>Route</dt><dd><code>${esc(n.route)}</code></dd>` : ''}
      </dl>
      ${shotsOf(n)}
      ${wireframe(n)}
      ${group('Reads', n.reads)}
      ${group('Calls', n.calls)}
      ${group('Opens', n.opens)}
      ${inside.length ? `<p class="usedby"><span>Shows</span> ${inside.map((c) => link(c.ref)).join(' ')}</p>` : ''}
      ${backlinks(n)}
    </section>`;
}

/* A page and an overlay are both `website`; only one of them has an address. */
const CARD = {
	db: dbCard,
	backend: backendCard,
	website: (n) => (n.type ? overlayCard(n) : pageCard(n)),
	app: appCard,
	flow: flowCard
};

/** One node's panel. The hover preview is the same card, minus three things. */
export const cardFor = (node) => CARD[node.kind](node);

/**
 * THE CONTENTS RAIL SAYS WHAT EACH THING IS, not only what it is called.
 *
 * A column of bare names — `users`, `info`, `sessions`, `orders`, `signin` — is
 * a list of words you have to already know. Half of them are a service and a
 * path away from being self-explanatory, and that pair is exactly what the card
 * underneath opens with, so the rail was withholding something it had.
 *
 * TWO FACTS AT MOST, AND THEY ARE THE TWO THE CARD LEADS WITH: where a thing
 * lives, or how it is reached. Anything more and the rail stops being a rail —
 * it is meant to be scanned down, and a reader scanning wants to find the row,
 * not read it.
 *
 * A LONG PATH IS CUT BY THE STYLESHEET rather than here, so nothing is lost:
 * the full value is in the markup, and the ellipsis is the browser's, at
 * whatever width the rail happens to be.
 */
const RAIL = {
	db: (n) => [
		['Service', n.service],
		['Location', n.location]
	],
	backend: (n) => [
		['Trigger', n.trigger],
		['Reached by', n.location],
		...(n.middleware ? [['Auth', n.middleware]] : [])
	],
	/* The name IS the address for a page, so repeating it would be one of the two
	   lines saying nothing. An overlay has no address and its kind is the fact. */
	website: (n) =>
		n.type
			? [
					['Kind', n.type],
					['Shots', `${n.screenshots?.length ?? 0}`]
				]
			: [
					['Rendered', n.renderName],
					['Location', n.location]
				],
	/* A screen is where it lives. A component has no address at all, which is
	   the thing to say about it first. */
	app: (n) => (n.route ? [['Route', n.route]] : [['Drawn in', 'a screen']]),
	/* A flow is its sequence: the first step and how many follow it. */
	flow: (n) => [
		['Opens', n.steps[0]?.name],
		['Steps', `${n.steps.length}`]
	]
};

function railEntry(href, name, facts) {
	return `
    <a href="${href}">
      <span class="rail__name">${esc(name)}</span>
      ${facts
				.filter(([, value]) => value)
				.map(
					([label, value]) => `
      <span class="rail__fact">
        <span class="rail__label">${esc(label)}</span>
        <span class="rail__value">${esc(value)}</span>
      </span>`
				)
				.join('')}
    </a>`;
}

/** Draw an index of every node of one kind. */
/**
 * Draw one page: every entity of one kind, in one environment.
 *
 * THE ENVIRONMENT AND THE KIND COME FROM THE ADDRESS rather than from eight
 * hand-written HTML files each passing its own title. `/business/db` is the
 * whole instruction.
 */
export function index(env, kind) {
	/*
	 * COMPONENTS ARE `app` TOO, and they are drawn at the FOOT of the page
	 * rather than among the screens — so they are taken out here and put back
	 * below, the way the shared types and the middleware are. Leaving them in
	 * rendered every one of them twice.
	 */
	const nodes = ALL.filter(
		(n) => n.env === env && n.kind === kind && n.appKind !== 'component'
	);

	/*
	 * THE SHARED TYPES RIDE ALONG WITH THE COLLECTIONS, because that is the only
	 * page whose listings reference them and a reader following `Address` should
	 * land on the same sheet rather than somewhere else entirely.
	 */
	const types = kind === 'db' ? TYPES.filter((t) => t.env === env) : [];

	/* And the middleware rides along with the scripts, for the same reason. */
	const middleware = kind === 'backend' ? MIDDLEWARE.filter((m) => m.env === env) : [];

	/* And the components after the screens, for the same reason again: they are
	   read when something above referred to one, not first. */
	const components = kind === 'app' ? COMPONENTS.filter((c) => c.env === env) : [];

	document.body.innerHTML = `
    <div class="sheet">
      ${chrome(env, kind)}
      <nav class="contents">
        <h2>On this page</h2>
        ${nodes.map((n) => railEntry(`#${anchorOf(n)}`, n.name, RAIL[kind](n))).join('')}
        ${
					types.length
						? `<h2 class="contents__more">Types</h2>` +
							types.map((t) => railEntry(`#${anchorOf(t)}`, t.name, [])).join('')
						: ''
				}
        ${
					middleware.length
						? `<h2 class="contents__more">Middleware</h2>` +
							middleware
								.map((m) => railEntry(`#${anchorOf(m)}`, m.name, [['Does', m.note]]))
								.join('')
						: ''
				}
        ${
					components.length
						? `<h2 class="contents__more">Components</h2>` +
							components.map((c) => railEntry(`#${anchorOf(c)}`, c.name, [])).join('')
						: ''
				}
      </nav>
      <main class="spec">
        ${nodes.length || types.length || middleware.length || components.length ? '' : empty(env, kind)}
        ${nodes.map((n) => CARD[kind](n)).join('')}
        ${types.map(typeCard).join('')}
        ${middleware.map(middlewareCard).join('')}
        ${components.map(appCard).join('')}
      </main>
      <aside class="margin"><div class="margin__rail"><h2>The margin</h2><div id="marks"></div></div></aside>
    </div>`;
}

/**
 * A PAGE WITH NOTHING ON IT SAYS SO, and says which file to write into.
 *
 * The business side is being built and most of its pages are empty. An empty
 * page that renders as a blank column reads as a page that failed to load; one
 * that names the file it draws from is an invitation.
 */
const empty = (env, kind) => `
  <p class="empty">
    Nothing described here yet — <code>docs/data/${esc(env)}/${esc(
			kind === 'flow' ? 'flows' : kind === 'app' ? 'app' : kind
		)}.json</code>
  </p>`;
