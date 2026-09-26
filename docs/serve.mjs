import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

/**
 * The documentation, served locally so it can be written on.
 *
 * WHY A SERVER AND NOT JUST AN HTML FILE. The whole point of this document is
 * that it can be commented on and that the comments land in `comments.json`
 * where an agent can read them. A page opened with `file://` cannot write
 * anything to disk, and `localStorage` would strand the comments inside one
 * browser profile where nothing else can reach them.
 *
 * WHY IT IS NOT DEPLOYED ANYWHERE. This describes the security rules, the shape
 * of every collection, and which endpoints exist. That is exactly the document
 * an attacker would like and exactly the document a customer has no use for.
 * It binds to 127.0.0.1 and is not on the internet, which is the correct place
 * for it.
 *
 *     node docs/serve.mjs        then open http://127.0.0.1:4321
 */

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STORE = join(ROOT, 'comments.json');
const PORT = 4321;

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	/*
	 * EVERY SCREENSHOT IN THIS DOCUMENT IS A WEBP, and this line was missing.
	 *
	 * Without it they fell to the `application/octet-stream` default below,
	 * which is not a wrong guess so much as an instruction: a browser handed
	 * that DOWNLOADS the file rather than showing it. So clicking any
	 * screenshot dropped a `.webp` into the Downloads folder and left the page
	 * where it was — no error, nothing in the console, and the one clue was a
	 * file appearing somewhere nobody was looking.
	 */
	'.webp': 'image/webp',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2'
};

async function comments() {
	if (!existsSync(STORE)) return [];
	try {
		return JSON.parse(await readFile(STORE, 'utf8'));
	} catch {
		/* A corrupt store should not take the document down — it is a review
		   tool, and losing the page loses the ability to fix the store. */
		return [];
	}
}

async function save(all) {
	await mkdir(ROOT, { recursive: true });
	/* Pretty-printed on purpose. This file is read by a person and by an agent,
	   and it goes through git — a one-line blob would make every diff useless. */
	await writeFile(STORE, JSON.stringify(all, null, 2) + '\n');
}

const json = (res, code, body) => {
	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
};

const body = (req) =>
	new Promise((resolve) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			try {
				resolve(JSON.parse(raw || '{}'));
			} catch {
				resolve({});
			}
		});
	});

const app = createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	if (url.pathname === '/api/comments') {
		if (req.method === 'GET') return json(res, 200, await comments());

		if (req.method === 'POST') {
			const { location, text, author } = await body(req);
			/*
			 * A LOCATION IS THREE STRINGS: the file, the list inside it, and the
			 * entry's key — `["backend.json", "proxyFunctions", "attribution"]`.
			 *
			 * CHECKED HERE RATHER THAN TRUSTED, because a note whose location is
			 * malformed is a note that can never be resolved to anything and never
			 * shows in the margin: it would sit in the file looking like feedback
			 * nobody acted on. This was learned the other way round — the element
			 * anchor was dropped on the way in once, and every comment quietly
			 * became a comment about a whole page.
			 */
			const ok =
				Array.isArray(location) &&
				location.length === 3 &&
				location.every((part) => typeof part === 'string' && part.trim());
			if (!ok) return json(res, 400, { error: 'Need a location of [file, list, key].' });
			if (!text?.trim()) return json(res, 400, { error: 'Need something to say.' });
			const all = await comments();
			const note = {
				id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
				location,
				text: String(text).trim().slice(0, 4000),
				author: (author || 'Panth').slice(0, 60),
				status: 'open',
				createdAt: new Date().toISOString(),
				/* Filled in by the agent when it acts on the note, so the file is a
				   record of what was done and not only of what was asked. */
				resolution: null
			};
			all.push(note);
			await save(all);
			return json(res, 201, note);
		}

		if (req.method === 'PATCH') {
			const { id, status, resolution } = await body(req);
			const all = await comments();
			const note = all.find((c) => c.id === id);
			if (!note) return json(res, 404, { error: 'No such comment.' });
			if (status) note.status = status;
			if (resolution !== undefined) note.resolution = resolution;
			await save(all);
			return json(res, 200, note);
		}

		if (req.method === 'DELETE') {
			const { id } = await body(req);
			await save((await comments()).filter((c) => c.id !== id));
			return json(res, 200, { ok: true });
		}

		return json(res, 405, { error: 'GET, POST, PATCH or DELETE.' });
	}

	/*
	 * Clean URLs. `/backend` is the address a cross-link uses and the address
	 * somebody types; `.html` on the end of every one of them would be a detail
	 * of how the files happen to be stored leaking into the document.
	 */
	/*
	 * EIGHT ADDRESSES AND ONE FILE. `/public/db`, `/business/flows` — the
	 * environment and the page, which is the whole instruction the renderer
	 * needs. `page.html` reads them out of the path.
	 *
	 * `/` IS THE PUBLIC DB PAGE. There was an index describing the pages in a
	 * paragraph each, which is a door in front of an open one, and a graph
	 * answering "what would this change touch" — which every card now answers
	 * exactly, in words, under Touches and Used by.
	 */
	let wanted = url.pathname;
	/*
	 * `/`, `/public` AND `/business` ALL LAND ON A PAGE. A bare environment is a
	 * thing somebody types and a thing the bar could hand back if a page were
	 * ever dropped from one; answering it with "Not here." is the document
	 * telling a reader they typed its own address wrongly.
	 */
	if (wanted === '/') wanted = '/plan/architecture.html';
	else if (/^\/(app|platform)(\/[a-z]+)?\/?$/.test(wanted)) {
		wanted = '/page.html';
	}

	/*
	 * THE MIGRATION PAGES ARE NOT PART OF THE MODEL, and that is why they are
	 * four files rather than another environment. Everything under `/public` and
	 * `/business` is a VIEW of `docs/data/**` — the same entities drawn as cards,
	 * a graph and a set of cross-links. A migration is not an entity: it is an
	 * argument about two systems, with tables of what maps to what and what is
	 * lost. Forcing it into the card model would say less and cost more.
	 *
	 * They keep the document's stylesheet, so they are the same paper.
	 */
	/* A BARE ENVIRONMENT OPENS ON ITS FIRST PAGE, which is what `/public` and
	   `/business` already do a few lines above. `/migrate` used to have an index
	   of its own describing the three pages in a paragraph each — a door in
	   front of an open one. */
	if (/^\/plan\/?$/.test(wanted)) wanted = '/plan/architecture.html';
	else if (/^\/plan\/[a-z-]+\/?$/.test(wanted)) {
		wanted = `/plan/${wanted.split('/')[2]}.html`;
	}

	/* Static, and confined to this directory. `normalize` collapses any `..`
	   before the join, so a request cannot climb out into the repository. */
	const path = join(ROOT, normalize(wanted).replace(/^(\.\.[/\\])+/, ''));
	if (!path.startsWith(ROOT) || !existsSync(path)) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not here.');
	}

	/*
	 * NEVER CACHED. This document is edited while it is open — by hand and by an
	 * agent acting on its own comments — and a stale script here does not look
	 * like a caching problem. It looks like the feature is broken: comments save
	 * but lose their anchor, because the old code was still running. That cost
	 * twenty minutes once.
	 */
	res.writeHead(200, {
		'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
		'Cache-Control': 'no-store, max-age=0'
	});
	res.end(await readFile(path));
});

/*
 * SAY SO WHEN THE PORT IS TAKEN, rather than exiting quietly.
 *
 * A silent EADDRINUSE cost real time once: a stale copy of this server held
 * 4321, every restart failed without a word, and the fixes being made to the
 * server appeared to do nothing at all — so the hunt went to the client, where
 * the bug was not.
 */
app.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.error(`\n  Port ${PORT} is already in use — the specification may already be`);
		console.error(`  running. Open http://127.0.0.1:${PORT}, or stop it with:\n`);
		console.error('    node docs/serve.mjs  (kill the old one first)\n');
		process.exit(1);
	}
	throw error;
});

app.listen(PORT, '127.0.0.1', () => {
	console.log(`\n  TaskManager — the specification\n  http://127.0.0.1:${PORT}\n`);
	console.log('  /plan/architecture  /plan/decisions  /plan/roadmap  /plan/reference  /plan/run');
	console.log('  /app/db  /app/backend  /app/screens  /app/flows');
	console.log('  /platform/db  /platform/backend  /platform/flows\n');
});
