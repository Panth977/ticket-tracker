/**
 * Marking up the specification, one entity at a time.
 *
 * A NOTE IS PINNED TO A JSON ENTITY, NOT TO AN ELEMENT ON A PAGE.
 *
 *   { text: "...", location: ["backend.json", "proxyFunctions", "attribution"] }
 *
 * The file, the list inside it, and the entry's key — the same three things
 * somebody editing the document would need in order to act on the note.
 *
 * IT USED TO BE AN ELEMENT, recorded three ways: a CSS path inside the section,
 * the words it was written against, and the section itself, resolved in that
 * order with a flag in the margin saying which one had held. All of that was
 * machinery for a problem that should not exist — every one of those is a
 * property of a RENDERING, and this document is MEANT to be rewritten. That is
 * the loop: mark it, the agent changes it, read it again. The rewrite is
 * precisely the moment a path stops parsing and a quoted sentence stops
 * matching, so the anchor was at its most fragile exactly when it was needed.
 *
 * An entity's coordinates do not change when its prose does. `users` is
 * `db.json · schema · users` before and after somebody rewrites its rules.
 *
 * THE COST IS GRAIN, AND IT IS WORTH PAYING. There is no marking one row of a
 * table or one line of an interface any more. "This collection's rules are
 * wrong" is a note about the collection; where inside the card that lives is
 * the document's business rather than the reader's — and a note that says which
 * field it means says so in its own words, which is what the text is for.
 *
 * A note whose entity has been renamed away says so, and is not reattached to
 * anything. Pretending otherwise would put a comment about one endpoint beside
 * another.
 */

import * as lightbox from './lightbox.js';
import * as peek from './peek.js';
import { atLocation, locKey } from './model.js';

const state = { comments: [], mode: false, composing: null };

const $ = (s, r = document) => r.querySelector(s);
const rail = () => $('#marks');

/**
 * WHAT A NOTE CAN BE ATTACHED TO: a card, and nothing finer.
 *
 * `data-loc` is put on every card by `render.js` and holds the entity's
 * coordinates in the JSON. Using the attribute rather than a list of selectors
 * means the two can never disagree about what is markable — anything rendered
 * from an entity is, anything else is not.
 */
const TARGETS = '[data-loc]';

async function api(method, body) {
	const res = await fetch('/api/comments', {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'That did not work.');
	return res.json();
}

const esc = (s) =>
	String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const when = (iso) =>
	new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * The words an element reads as, used both to quote it back and to find it
 * again after the document has been rewritten around it.
 *
 * `innerText`, NOT `textContent`. textContent concatenates without regard to
 * layout, so a table row came out as `rideremailThis field IS the rider's
 * permission` — unreadable as a quote, and a fragile thing to match on because
 * one CSS change to how cells are laid out does not alter it but any edit to
 * the markup does. innerText is what the row actually reads as on screen,
 * which is what somebody thought they were annotating.
 */
const words = (el) =>
	((el?.innerText ?? el?.textContent) ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);

/* ── Anchoring ─────────────────────────────────────────────────────────── */

/** The element the composer is currently attached to, so it can be lit. */
let composingEl = null;

function light(el) {
	document.querySelectorAll('.composing').forEach((n) => n.classList.remove('composing'));
	composingEl = el ?? null;
	if (el) el.classList.add('composing');
}

/**
 * Find what a note was written against.
 *
 * ONE LOOKUP, AND IT EITHER HOLDS OR IT DOES NOT. There is no ladder of
 * fallbacks any more because there is nothing to fall back to: an entity is on
 * this page or on another one, and it exists or it has been renamed away.
 * `sure` is kept so the margin can still say which — but the states are facts
 * now rather than degrees of confidence.
 */
/**
 * The page a note's entity is described on. A location's first part is
 * `<environment>/<file>`, and the file names the kind: `business/flows.json`
 * is described at `/business/flows`.
 */
function pageOfLocation(loc) {
	const [where] = loc ?? [];
	if (!where) return null;
	const [env, file] = where.split('/');
	const kind = {
		'db.json': 'db',
		'backend.json': 'backend',
		'website.json': 'website',
		'app.json': 'screens',
		'flows.json': 'flows'
	}[file];
	return kind ? `/${env}/${kind}` : null;
}

function resolve(c) {
	const page = pageOfLocation(c.location);
	/* Scanned rather than selected. A location is JSON, and JSON inside a CSS
	   attribute selector is a quoting game with nothing to win. */
	const want = locKey(c.location);
	const el = [...document.querySelectorAll('[data-loc]')].find((n) => n.dataset.loc === want);
	if (el) return { el, sure: 'exact' };
	if (page && page !== window.location.pathname) return { el: null, sure: 'elsewhere' };
	/* Not on this page, and not a file this document renders — or the entity has
	   been renamed. `atLocation` is what tells those apart. */
	return { el: null, sure: atLocation(c.location) ? 'elsewhere' : 'gone' };
}

/** How a location reads in the margin: `backend.json · proxyFunctions · …`. */
const trail = (loc) => (Array.isArray(loc) ? loc.join(' · ') : '');

/* ── Drawing ───────────────────────────────────────────────────────────── */

function paint() {
	document.querySelectorAll('[data-marked]').forEach((el) => {
		el.removeAttribute('data-marked');
		el.removeAttribute('data-marks');
	});

	const open = state.comments.filter((c) => c.status !== 'resolved');
	open.forEach((c, i) => {
		const hit = resolve(c);
		if (!hit?.el) return;
		hit.el.setAttribute('data-marked', hit.sure);
		hit.el.setAttribute('data-marks', String(i + 1));
		c._n = i + 1;
	});
}

function draw() {
	const box = rail();
	if (!box) return;
	const open = state.comments.filter((c) => c.status !== 'resolved');
	const done = state.comments.filter((c) => c.status === 'resolved');

	/*
	 * `elsewhere` IS NOT A FAILURE and `gone` is. One means the note is about a
	 * different page — ordinary, and the margin lists it so the count is honest.
	 * The other means the entity it names is not in the JSON at all any more,
	 * which is a note nobody can act on and is worth looking loud.
	 */
	const lost = { exact: '', elsewhere: 'another page', gone: 'no longer exists' };

	const mark = (c) => {
		const hit = resolve(c);
		const flag = lost[hit.sure];
		return `
      <article class="mark ${c.status === 'resolved' ? 'mark--done' : ''}" data-id="${c.id}">
        <span class="mark__where" data-show="${c.id}">
          ${c._n && c.status !== 'resolved' ? `<b class="pin">${c._n}</b>` : ''}${esc(c.location?.at(-1) ?? '')}
          ${flag ? `<em class="mark__flag">${flag}</em>` : ''}
        </span>
        <p class="mark__quote">${esc(trail(c.location))}</p>
        <p class="mark__text">${esc(c.text)}</p>
        ${c.resolution ? `<p class="mark__resolution">${esc(c.resolution)}</p>` : ''}
        <div class="mark__foot">
          <span>${esc(c.author)} · ${when(c.createdAt)}</span>
          ${
						c.status === 'resolved'
							? `<button data-reopen="${c.id}">reopen</button>`
							: `<button data-resolve="${c.id}">mark done</button>`
					}
          <button data-delete="${c.id}">delete</button>
        </div>
      </article>`;
	};

	box.innerHTML =
		(open.length
			? open.map(mark).join('')
			: state.composing
				? ''
				: `<p class="empty">Nothing marked yet. Press <b>Comment</b> below, then shift-click anything.</p>`) +
		(done.length ? `<h2 class="mark__done-head">Done</h2>${done.map(mark).join('')}` : '');

	const button = $('#comment-toggle');
	if (button) {
		button.classList.toggle('on', state.mode);
		button.querySelector('.dock__n').textContent = open.length || '';
		button.querySelector('.dock__label').textContent = state.mode ? 'Done commenting' : 'Comment';
	}
}

/**
 * The composer, opened where the click was.
 *
 * ABSOLUTE, IN DOCUMENT COORDINATES, not fixed to the viewport — so it stays
 * on the thing it belongs to when the page scrolls underneath it. A note is
 * about what is under the cursor, and a panel that lives somewhere else makes
 * the eye travel away from that to write it.
 *
 * It flips left and up near the edges, because a card that opens off-screen is
 * a card nobody can use and the right-hand margin is exactly where somebody
 * will be clicking.
 *
 * THERE IS NO "WIDER" ANY MORE. It existed because a click landed on whatever
 * was nearest — a cell, then the row, then the table — and needed a way back
 * up when the nearest was not what was meant. One grain needs no ladder.
 */
function openComposer() {
	document.getElementById('composer')?.remove();
	if (!state.composing) return;

	/*
	 * THE THING BEING MARKED STAYS LIT WHILE YOU TYPE. Without it the composer
	 * is a box floating over a page of near-identical cards, and by the second
	 * sentence you are no longer certain which one you clicked.
	 */
	light(state.composing.el);

	const { at, location: loc } = state.composing;
	const card = document.createElement('form');
	card.className = 'pop';
	card.id = 'composer';
	card.innerHTML = `
    <p class="pop__where">
      <b>${esc(loc.at(-1))}</b>
      <span class="pop__loc">${esc(loc.slice(0, -1).join(' · '))}</span>
    </p>
    <textarea id="composer-text" placeholder="What should change about this?" required></textarea>
    <div class="pop__row">
      <button class="btn" type="submit">Leave the note</button>
      <button class="btn btn--quiet" type="button" id="composer-cancel">Cancel</button>
    </div>`;
	document.body.appendChild(card);

	const width = card.offsetWidth;
	const height = card.offsetHeight;
	const flipX = at.x + width + 24 > document.documentElement.clientWidth + window.scrollX;
	const flipY = at.y + height + 24 > window.scrollY + window.innerHeight;
	card.style.left = `${Math.max(12, flipX ? at.x - width - 12 : at.x + 12)}px`;
	card.style.top = `${Math.max(12, flipY ? at.y - height - 12 : at.y + 12)}px`;

	const text = card.querySelector('#composer-text');
	text.focus();

	card.addEventListener('submit', async (e) => {
		e.preventDefault();
		if (!text.value.trim()) return;
		const note = await api('POST', {
			location: loc,
			text: text.value,
			author: localStorage.getItem('docs.author') || 'Panth'
		});
		state.comments.push(note);
		state.composing = null;
		closeComposer();
		paint();
		draw();
	});
	card.querySelector('#composer-cancel').addEventListener('click', () => {
		state.composing = null;
		closeComposer();
	});
}

function closeComposer() {
	document.getElementById('composer')?.remove();
	light(null);
}

/* ── Comment mode ──────────────────────────────────────────────────────── */

function setMode(on) {
	state.mode = on;
	document.body.classList.toggle('commenting', on);
	if (!on) {
		state.composing = null;
		closeComposer();
	}
	paint();
	draw();
}

document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		/* Escape closes the topmost thing first: the enlarged screenshot, then the
		   composer, then the mode. Backing out of one should never drop you out of
		   the one underneath it as well. */
		if (lightbox.isOpen()) return lightbox.shut();
		if (state.composing) {
			state.composing = null;
			return closeComposer();
		}
		if (state.mode) setMode(false);
	}
	/* The same key that turns it on turns it off, so it never becomes a mode
	   somebody is stuck in. */
	if (e.key.toLowerCase() === 'c' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
		e.preventDefault();
		setMode(!state.mode);
	}
});

document.addEventListener(
	'click',
	async (event) => {
		const target = event.target;

		if (target.closest('#comment-toggle')) {
			event.preventDefault();
			return setMode(!state.mode);
		}

		/* SHIFT-CLICK ADDS. Plain click is left alone on purpose — the document is
		   full of cross-references, and a mode that swallowed every click would
		   make reading it impossible while marking it up. */
		if (state.mode && event.shiftKey) {
			const el = target.closest(TARGETS);
			/* Not the preview card: it renders the same markup, so a shift-click in
			   one would leave a note that looks identical and points at the same
			   entity — from a card that disappears the moment the pointer moves. */
			if (el && !el.closest('.margin, .dock, .pop, .peek')) {
				event.preventDefault();
				event.stopPropagation();
				state.composing = {
					location: JSON.parse(el.dataset.loc),
					at: { x: event.pageX, y: event.pageY },
					/* Kept out of what is POSTed — see the submit handler. */
					el
				};
				openComposer();
				return;
			}
		}

		const show = target.closest('[data-show]')?.dataset.show;
		if (show) {
			const hit = resolve(state.comments.find((c) => c.id === show));
			if (hit?.el) {
				hit.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				hit.el.classList.add('flash');
				setTimeout(() => hit.el.classList.remove('flash'), 900);
			}
			return;
		}

		for (const [attr, patch] of [
			['resolve', { status: 'resolved' }],
			['reopen', { status: 'open' }]
		]) {
			const id = target.dataset?.[attr];
			if (id) {
				const updated = await api('PATCH', { id, ...patch });
				state.comments = state.comments.map((c) => (c.id === id ? updated : c));
				paint();
				return draw();
			}
		}

		const remove = target.dataset?.delete;
		if (remove) {
			await api('DELETE', { id: remove });
			state.comments = state.comments.filter((c) => c.id !== remove);
			paint();
			draw();
		}
	},
	true
);

/*
 * STOP THE BROWSER SELECTING TEXT BEFORE WE SEE THE CLICK.
 *
 * Shift-click is the native gesture for extending a selection, so in comment
 * mode a shift-click did exactly that — dragged a blue selection across half
 * the table — and the composer never opened, because `click` fires after
 * `mousedown` has already done the damage. Cancelling the mousedown is the
 * only place this can be caught.
 */
document.addEventListener(
	'mousedown',
	(event) => {
		if (!state.mode || !event.shiftKey) return;
		if (event.target.closest('.pop, .dock, .peek')) return;
		if (event.target.closest(TARGETS)) {
			event.preventDefault();
			/* A selection left over from before the mode was turned on would still
			   be painted over the thing being marked. */
			window.getSelection()?.removeAllRanges();
		}
	},
	true
);

/* ── The dock ──────────────────────────────────────────────────────────── */

const dock = document.createElement('div');
dock.className = 'dock';
dock.innerHTML = `
  <button id="comment-toggle" class="dock__btn" type="button">
    <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15">
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.2A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </svg>
    <span class="dock__label">Comment</span>
    <span class="dock__n"></span>
  </button>
  <span class="dock__hint">Shift-click anything to mark it · Esc to stop</span>`;
document.body.appendChild(dock);

/*
 * Enlarging a screenshot, but never while a note is being placed on one.
 *
 * The comment mode owns shift-click and the lightbox owns plain click, so they
 * do not actually collide — but the guard is stated rather than relied upon,
 * because "these two gestures happen not to overlap today" is the sort of
 * thing that stops being true the next time either one is touched.
 */
lightbox.listen({ skip: (event) => state.mode && event.shiftKey });

/* The declaration of a type, on hover, without leaving the line being read. */
peek.listen();

/*
 * Which section is being read — and keeping it in sight.
 *
 * THE RAIL SCROLLS ON ITS OWN NOW, which is what makes the second half of this
 * necessary. A page listing thirty-three things has a rail taller than the
 * window, so the entry the reader is currently inside is often somewhere the
 * rail is not showing: it lights up out of view, and the rail sits pointing at
 * a section nobody is near.
 *
 * `nearest` rather than `center`: an entry already visible must not be moved,
 * or the rail creeps under the reader on every scroll.
 */
const spy = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const want = `#${entry.target.id}`;
			for (const a of document.querySelectorAll('.contents a')) {
				const on = a.getAttribute('href') === want;
				a.classList.toggle('on', on);
				if (on) a.scrollIntoView({ block: 'nearest' });
			}
		}
	},
	{ rootMargin: '-10% 0px -80% 0px' }
);
document.querySelectorAll('.block').forEach((b) => spy.observe(b));

api('GET')
	.then((all) => {
		state.comments = all;
		paint();
		draw();
	})
	.catch(() => {
		if (rail()) {
			rail().innerHTML =
				'<p class="empty">Comments need the local server — run <code>npm run docs</code>.</p>';
		}
	});
