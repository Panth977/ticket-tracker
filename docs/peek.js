import { atAnchor } from './model.js';

/** Which environment this page is showing. The anchor is resolved inside it
    first, because a name can exist on both sides. */
const ENV = () => location.pathname.split('/')[1] || 'app';
import { previewFor, previewMiddleware, previewType } from './render.js';

/**
 * What is on the other end of a link, without going there.
 *
 * WHY A HOVER AND NOT JUST THE LINK. The link already works and it costs a
 * jump: `status: OrderStatus` sends you to the foot of the page, `authEmailS2`
 * sends you to another page entirely, and coming back means finding your place
 * in an interface you were half way through. Nine times in ten the question is
 * "what are the five values" or "what does that endpoint take" rather than
 * "take me there" — a glance, not a navigation.
 *
 * EVERY LINK, NOT ONLY THE TYPES. It began as a type peek, which left the
 * asymmetry that the cheapest jump on the page — a type, a few lines down —
 * was the only one you were spared, while `Used by backend · authEmailS2`, the
 * jump that actually costs you your place, had nothing. A reader following
 * "who touches this" is asking what those things ARE.
 *
 * IT SHOWS THE REAL CARD, rendered by the same functions the page uses — the
 * rules and the schema as code blocks, a page's screenshot as the screenshot.
 * It was a monospace box holding whatever text the kind happened to have, so a
 * page previewed as a paragraph while its listing IS a paragraph and a picture.
 * A preview that leaves out the picture answers a different question from the
 * one the reader asked. Only the name, the section id and the backlinks are
 * dropped — see `previewFor` for why each.
 *
 * SO BOTH. Hover to look, click to go. The link is untouched, which is what
 * keeps this from being the only way to read any of it: it still works with a
 * keyboard, still works if this script never loads, and still works on a phone,
 * where there is no hover and tapping the link is the honest answer.
 *
 * FOCUS SHOWS IT TOO, so tabbing through a listing is not a worse experience
 * than pointing at it.
 */

/*
 * THE SAME WAIT BOTH WAYS, AND THE EXIT ONE IS DOING MORE WORK THAN IT LOOKS.
 *
 * Opening late stops a cursor swept across an interface strobing a dozen cards.
 * Closing late is what makes the card REACHABLE: there is a gap between the
 * link and the card, and crossing it means leaving the link before arriving at
 * the card. Shut immediately and the card is gone before the pointer lands.
 */
const OPEN_AFTER_MS = 200;
const SHUT_AFTER_MS = 200;

let card = null;
let openTimer = null;
let shutTimer = null;
let showing = null;

/* ── What a link points at ──────────────────────────────────────────────── */

/**
 * ANYTHING WITH A FRAGMENT, resolved against everything the document knows.
 *
 * Matching on the class would have covered the cross-links and missed the
 * contents rail down the side, which is the same jump wearing a different
 * appearance. A link this cannot resolve — a tab, an external address, the
 * masthead — gets no card, which is the right answer for a link that points at
 * nothing this document describes.
 *
 * ONE LOOKUP, because an anchor is built from the entity: `schema-users`,
 * `types-address`, `middleware-maybe-auth`. It used to be three tries in a row
 * against three different id shapes.
 */
function subject(anchor) {
	const href = anchor.getAttribute('href') ?? '';
	const cut = href.indexOf('#');
	if (cut < 0) return null;
	const found = atAnchor(ENV(), href.slice(cut + 1));
	return found ? { kind: found.source[1], it: found } : null;
}

/* ── What the card says ─────────────────────────────────────────────────── */

/**
 * WHAT TO DRAW, BY THE LIST THE ENTITY CAME FROM. A type is a declaration and a
 * middleware is a sentence and a pseudo-code; everything else is its own card.
 */
const BODY = {
	types: previewType,
	middleware: previewMiddleware
};

const bodyFor = (found) => (BODY[found.kind] ?? previewFor)(found.it);

function build() {
	card = document.createElement('div');
	card.className = 'peek';
	card.setAttribute('role', 'tooltip');
	card.id = 'link-peek';
	card.hidden = true;
	/*
	 * IT TAKES THE POINTER, so the cursor can rest in it: an interface of nine
	 * lines is a thing somebody wants to read at their own pace, select a field
	 * name out of, and scroll when it runs long. A card that vanishes when you
	 * reach for it is a card you cannot use for any of that.
	 *
	 * What that costs is the flicker this was avoiding — moving off the link
	 * fires a leave before the card fires an enter. The exit delay covers the
	 * crossing, and arriving at the card cancels the pending close.
	 */
	card.addEventListener('mouseenter', clearTimers);
	card.addEventListener('mouseleave', wantShut);
	document.body.appendChild(card);
}

/**
 * Put it where it can be read, which is not always below.
 *
 * Measured AFTER the content is in, because the height depends on what is being
 * shown — `Branch` is one line and a flow is nine — and a position computed
 * from a guess puts the short one in the wrong place.
 */
function place(anchor) {
	const at = anchor.getBoundingClientRect();
	const box = card.getBoundingClientRect();
	const gap = 8;
	const margin = 12;

	/* Below, unless there is not room and there is room above. */
	const under = at.bottom + gap;
	const over = at.top - box.height - gap;
	const top = under + box.height + margin <= window.innerHeight || over < margin ? under : over;

	/* Aligned to the link, then pulled back inside the window. */
	let left = at.left;
	const overflow = left + box.width + margin - window.innerWidth;
	if (overflow > 0) left -= overflow;
	if (left < margin) left = margin;

	card.style.top = `${Math.max(margin, top)}px`;
	card.style.left = `${left}px`;
}

function show(anchor) {
	const found = subject(anchor);
	if (!found) return;
	const body = bodyFor(found);
	if (!body) return;
	if (!card) build();

	/*
	 * WRAPPED IN `.spec`, because the card markup is styled by descent from the
	 * sheet — the code blocks, the lede, the screenshot frame. Rendering it
	 * loose would give the right elements none of their appearance.
	 *
	 * Long enough to answer, short enough not to become the page: the card
	 * scrolls, and scrolling INSIDE it is one of the few things that does not
	 * dismiss it.
	 */
	card.innerHTML = `<div class="spec peek__card">${body}</div>`;
	card.hidden = false;
	/* Off-screen first, so the measurement in `place` is of the real content and
	   nobody sees it land in the wrong spot. */
	card.style.top = '-9999px';
	card.scrollTop = 0;
	place(anchor);

	anchor.setAttribute('aria-describedby', card.id);
	showing = anchor;
}

function hide() {
	if (!showing) return;
	showing.removeAttribute('aria-describedby');
	showing = null;
	if (card) card.hidden = true;
}

const clearTimers = () => {
	if (openTimer) clearTimeout(openTimer);
	if (shutTimer) clearTimeout(shutTimer);
	openTimer = shutTimer = null;
};

function wantOpen(anchor, delay) {
	clearTimers();
	if (showing === anchor) return;
	openTimer = setTimeout(() => show(anchor), delay);
}

function wantShut() {
	clearTimers();
	shutTimer = setTimeout(hide, SHUT_AFTER_MS);
}

/**
 * Every link that could be pointing at something described here.
 *
 * NOT THE CONTENTS RAIL. Its rows carry the same two facts the preview would
 * open with — the service and the path, the trigger and the address — so a card
 * over one of them repeats what the reader is already looking at, and covers
 * the page to do it. The preview is for links that go somewhere you cannot see
 * from here.
 */
const LINKS = 'a[href*="#"]:not(.contents a)';

/**
 * Wire it to the document.
 *
 * DELEGATED, because every page renders its whole body from a script — there is
 * no moment at which every link exists to be bound individually, and a listener
 * per link would be hundreds of them on a page with eleven interfaces on it.
 *
 * `mouseover` rather than `mouseenter`: the latter does not bubble, so it
 * cannot be delegated at all.
 */
export function listen() {
	document.addEventListener('mouseover', (event) => {
		const anchor = event.target.closest?.(LINKS);
		if (anchor && !anchor.closest('.peek')) return wantOpen(anchor, OPEN_AFTER_MS);
		/* Inside the card: whatever close was pending, the reader is still using
		   it. The card's own `mouseenter` covers arriving; this covers moving
		   about inside it, where no enter fires. */
		if (event.target.closest?.('.peek')) return clearTimers();
		if (showing) wantShut();
	});

	document.addEventListener('mouseout', (event) => {
		if (event.target.closest?.(LINKS)) wantShut();
	});

	/* Keyboard: no delay, because arriving by Tab is deliberate in a way that
	   sweeping a cursor over something is not. */
	document.addEventListener('focusin', (event) => {
		const anchor = event.target.closest?.(LINKS);
		if (anchor) wantOpen(anchor, 0);
		else if (showing) hide();
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && showing) hide();
	});

	/*
	 * ANYTHING THAT MOVES THE PAGE TAKES IT DOWN, rather than being followed.
	 * The card is positioned once, in viewport coordinates; a scroll leaves it
	 * pointing at a line that has moved on, which is worse than no card at all.
	 *
	 * EXCEPT A SCROLL INSIDE THE CARD ITSELF. It captures from `window`, so it
	 * hears every scroll in the document — including the one somebody does to
	 * read the end of a long schema, which would take the card away mid-read.
	 */
	window.addEventListener(
		'scroll',
		(event) => {
			if (event.target?.closest?.('.peek')) return;
			hide();
		},
		{ passive: true, capture: true }
	);
	window.addEventListener('resize', hide, { passive: true });

	/* Clicking the link goes to the thing; the card has served its turn. */
	document.addEventListener('click', (event) => {
		if (event.target.closest?.(LINKS)) hide();
	});
}
