/**
 * A screenshot, full screen.
 *
 * WHAT THIS REPLACED, AND WHY THE OLD REASONING WAS WRONG. Each picture was a
 * plain link to its own file, on the argument that the full-size image is one
 * click away in a browser that already knows how to zoom it, and that a
 * lightbox is a hundred lines reimplementing what the browser does.
 *
 * The browser does not do it. Following that link LEAVES the document — a new
 * tab holding one image, with the sentence it was evidence for now in a
 * different tab. In a document whose whole shape is "a step, and the screen it
 * happens on", that is the wrong exchange: you look at a screenshot for a few
 * seconds and you want to be back in the prose, not navigating home to it. And
 * when the server does not name the file type, "opens in a tab" is not even
 * what happens — Chrome downloads it. That was the actual behaviour here for
 * as long as there have been screenshots.
 *
 * SO IT IS A HUNDRED LINES, and they buy three things a tab cannot: the
 * caption stays attached to the picture, ← and → walk the screens of a flow in
 * order without going back to the page each time, and Escape returns you to
 * exactly the sentence you left.
 *
 * IT IS A MODULE OF ITS OWN rather than part of `docs.js`, so that anything
 * rendering the same cards gets the same behaviour by importing it. A picture
 * that only enlarged on some of the pages would be the kind of inconsistency
 * nobody reports and everybody notices.
 */

const FRAME = `
  <button class="lb__shut" type="button" aria-label="Close">✕</button>
  <button class="lb__step lb__step--back" type="button" aria-label="Previous screen">‹</button>
  <button class="lb__step lb__step--on" type="button" aria-label="Next screen">›</button>
  <figure class="lb__frame">
    <img class="lb__img" alt="">
    <figcaption class="lb__cap"><b></b><span></span></figcaption>
  </figure>
  <p class="lb__hint"></p>`;

let box = null;
let shots = [];
let at = -1;
/** What to put the focus back on, so Escape returns you where you were. */
let cameFrom = null;

/**
 * Every screenshot currently on screen, in the order they are read.
 *
 * COLLECTED WHEN IT OPENS, not once at startup. The pages render their whole
 * body from a script and are rewritten as the document is, so on a flow page
 * ← and → walk THIS page's screens as they are now.
 *
 * NOT THE HOVER PREVIEW'S COPY. It renders the same card, screenshot and all,
 * and counting it would put one screen in the walk twice. Its pictures are not
 * links either — see `shotOf` — so this is the belt to that brace.
 */
const gather = () => [...document.querySelectorAll('.shot > a')].filter((a) => !a.closest('.peek'));

function build() {
	box = document.createElement('div');
	box.className = 'lb';
	box.hidden = true;
	box.setAttribute('role', 'dialog');
	box.setAttribute('aria-modal', 'true');
	/* So the overlay itself can take the focus — see the note in `docs.css`. */
	box.tabIndex = -1;
	box.innerHTML = FRAME;
	document.body.appendChild(box);

	/*
	 * A CLICK ON THE GROUND CLOSES; A CLICK ON THE PICTURE ZOOMS.
	 *
	 * Both are the conventions people already have, and they do not collide
	 * because the picture is the only thing in the middle of the screen. The
	 * `figure` counts as ground: the gap beside a tall screenshot is somewhere
	 * you would click to get out.
	 */
	box.addEventListener('click', (event) => {
		if (event.target.closest('.lb__shut')) return shut();
		if (event.target.closest('.lb__step--back')) return step(-1);
		if (event.target.closest('.lb__step--on')) return step(1);
		if (event.target.closest('.lb__img')) return zoom();
		if (!event.target.closest('.lb__cap')) shut();
	});
}

function zoom() {
	const on = box.classList.toggle('lb--zoom');
	/* Back to the top of the picture rather than wherever the last one was
	   left, which on a tall screenshot is the middle of nothing. */
	if (on) box.scrollTop = 0;
	hint();
}

function hint() {
	box.querySelector('.lb__hint').textContent = [
		box.classList.contains('lb--zoom') ? 'Click to fit' : 'Click to zoom',
		shots.length > 1 ? `← → ${at + 1} of ${shots.length}` : null,
		'Esc to close'
	]
		.filter(Boolean)
		.join(' · ');
}

/**
 * Show one.
 *
 * THE CAPTION IS READ OUT OF THE PAGE, not passed in from the model. The
 * markup already carries both halves — the alt text names the screen, the
 * figcaption says what was staged to reach it — and taking them from the DOM
 * means this file never has to know that overlays and pages are different
 * things, or be edited when a caption is reworded.
 */
function show(index) {
	at = (index + shots.length) % shots.length;
	const anchor = shots[at];
	const source = anchor.querySelector('img');
	const caption = anchor.parentElement.querySelector('figcaption');

	const img = box.querySelector('.lb__img');
	/* Emptied first, so a slow load shows nothing rather than the previous
	   screen with the next one's caption under it. */
	img.removeAttribute('src');
	img.src = anchor.getAttribute('href');
	img.alt = source?.alt ?? '';

	box.querySelector('.lb__cap b').textContent = (source?.alt ?? '').replace(/ as it looks now$/, '');
	box.querySelector('.lb__cap span').textContent = caption?.textContent.trim() ?? '';
	box.classList.toggle('lb--captioned', !!caption);

	const many = shots.length > 1;
	box.querySelector('.lb__step--back').hidden = !many;
	box.querySelector('.lb__step--on').hidden = !many;

	box.classList.remove('lb--zoom');
	box.scrollTop = 0;
	hint();
}

const step = (by) => show(at + by);

export function open(anchor) {
	if (!box) build();
	shots = gather();
	const index = shots.indexOf(anchor);
	if (index < 0) return;

	cameFrom = anchor;
	box.hidden = false;
	/* The page behind must not scroll under the overlay — on a phone that turns
	   a swipe to dismiss into a swipe through the document. */
	document.body.classList.add('lb-open');
	show(index);
	box.focus();
}

export function shut() {
	if (!box || box.hidden) return;
	box.hidden = true;
	box.classList.remove('lb--zoom');
	document.body.classList.remove('lb-open');
	/* Back to the picture in the prose, which is where the reader was. */
	cameFrom?.focus();
	cameFrom = null;
}

export const isOpen = () => !!box && !box.hidden;

/**
 * Wire it to the document.
 *
 * `capture: true` SO THIS RUNS BEFORE THE COMMENT MODE DOES. Both want the
 * same click, and the comment mode's is the one that must win when it is on —
 * so the guard is here, and it is the caller's `skip` rather than a check of
 * some state this file should not know about.
 */
export function listen({ skip } = {}) {
	document.addEventListener(
		'click',
		(event) => {
			if (skip?.(event)) return;
			/* Modified clicks are the reader deliberately asking for a tab or a
			   window. Swallowing those would take away the escape hatch. */
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
			const anchor = event.target.closest('.shot > a');
			if (!anchor) return;
			event.preventDefault();
			open(anchor);
		},
		true
	);

	document.addEventListener('keydown', (event) => {
		if (!isOpen()) return;
		if (event.key === 'ArrowLeft') return step(-1);
		if (event.key === 'ArrowRight') return step(1);
		if (event.key === ' ' || event.key === 'Enter') {
			if (event.target.closest('.lb__shut, .lb__step')) return;
			event.preventDefault();
			zoom();
		}
	});
}
