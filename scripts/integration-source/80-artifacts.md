## 8. Artifacts

An **artifact** is a small website that lives inside TaskManager: a dashboard, a tracker, a form, a
tool. Somebody — usually an agent — writes the frontend in whatever they like, builds it to a static
folder and publishes that folder. TaskManager keeps it and shows it only to the signed-in people it
has been shared with. Its backend is one script tag: `window.BackendDriver` gives the page a
Firestore, a Realtime Database, file storage and a key-value store that belong to that one artifact.

Artifacts are a concept of their own, **separate from boards**: no tickets, no stages, their own
people. Being on a board gives you nothing on an artifact, and the reverse.

### 8.1 What an artifact is

- **A static build, nothing else.** A folder with an `index.html` at its root: plain HTML/CSS/JS, or
  the `dist/` of Vite, Svelte, React, Vue. Nothing is built or run on the server.
- **Relative asset paths.** The page is served under a prefix that changes, so `./assets/app.js`
  works and `/assets/app.js` shows a blank page. In Vite: `base: './'`. A publish with absolute
  paths still succeeds, and answers with a `warnings` entry naming the fix.
- **Hash routing, or a single page.** Route on `location.hash`. (A path that is not a file and has
  no extension falls back to `index.html`, so history routing mostly works — but the hash always does.)
- **Its data is its own.** Everything it stores sits under a prefix the artifact's code never sees
  and cannot leave. Publishing a new build never touches the data.
- **Builds are versions.** Every publish is a new build and becomes current at once. The newest ones
  are kept and any of them can be made current again.
- **The source can travel with it.** A publish may carry a zip of the source beside the build. It is
  never served; it is what the next author downloads to carry on.
- **It only runs inside TaskManager**, at `{{url:artifactsUrl}}{id}`, for a signed-in person it is
  shared with. There is no public link.

Who can do what:

```text
role     open it   read data   write data                              publish, roll back   share, rename, delete
──────   ───────   ─────────   ──────────                              ──────────────────   ─────────────────────
owner    yes       yes         yes                                     yes                  yes
editor   yes       yes         yes                                     yes                  no
viewer   yes       yes         yes — unless it is set read-only        no                   no
```

That table is for **people**. An **agent** has no role on an artifact: its owner gives it two
permissions, separately —

```text
build   true | false               publish, roll back, download the source
data    'none' | 'read' | 'write'  read, or read and write, the artifact's database and files
                                   through the data API (§8.10)
```

Either of them lets the agent list the artifact and read its description, builds and members. At
least one must be given: `{ build: false, data: 'none' }` means "take the agent off". A dashboard's
nightly job needs `data: 'write'` and no `build`; the agent that maintains the page needs `build`.
An agent never owns an artifact and never shares, renames or deletes one.

Limits:

```text
{{gen:artifactlimits}}
```

### 8.2 Tokens

Two scopes: `artifacts:read` (list, get, download source, read data) and `artifacts:write` (create,
publish, roll back, share, delete, write data). What a token *reaches*, and what it may do there, is
decided per call from each artifact's own people:

- an **account token** reaches every artifact where its person is owner or editor, with that
  person's role, and may create one;
- an **agent token** — the agent's one token (§2); it always carries both scopes — reaches the
  artifacts that agent is on, and does there what its `{ build, data }` says. `GET
  /v1/artifacts` and `GET /v1/artifacts/{id}` state it as `agent_access` (the `role` field reads
  `editor` for every agent and means nothing: read `agent_access`).
- An agent may **create** an artifact: it then belongs to the agent's **owner** (who sees it in
  their sidebar at once and gets an inbox row), and the agent is on it with `{ build: true, data:
  'write' }`.
- To put an agent on an existing artifact, or change what it may do, the **owner** shares it:
  `agent_access` beside `agent` (below), or the agent's own page in the app, which lists every
  artifact it is on with the two controls.

```bash
# the owner's account token: this agent may write the data, and not publish
curl -s -X PUT {{url:apiBase}}/artifacts/$ID/access \
  -H "Authorization: Bearer $TM_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "agent": "ag_0123456789abcdef", "agent_access": { "build": false, "data": "write" } }'
```

The older form still works for an agent — `"role": "editor"` is `{ build: true, data: 'write' }`,
`"role": null` removes it — and `agent_access` wins when both are given.

### 8.3 Publishing: REST

```text
{{gen:artifactrest}}
```

Full parameters and answers are in §5.2. The one route that is not JSON is the publish: the body
**is** the zip of the build folder.

```bash
# create (account token) → { id, url, … }
curl -s -X POST {{url:apiBase}}/artifacts \
  -H "Authorization: Bearer $TM_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "name": "Sales dashboard" }'

# publish: zip the CONTENTS of the build folder, not the folder
(cd dist && zip -qr ../build.zip .)
curl -s -X POST "{{url:apiBase}}/artifacts/$ID/builds?message=first%20cut" \
  -H "Authorization: Bearer $TM_TOKEN" -H 'Content-Type: application/zip' \
  -H "Idempotency-Key: $(uuidgen)" --data-binary @build.zip

# …or with the source beside it: multipart, parts named `build` and `source`
curl -s -X POST "{{url:apiBase}}/artifacts/$ID/builds?message=first%20cut" \
  -H "Authorization: Bearer $TM_TOKEN" \
  -F build=@build.zip -F source=@source.zip

# share
curl -s -X PUT {{url:apiBase}}/artifacts/$ID/access \
  -H "Authorization: Bearer $TM_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "email": "priya@example.com", "role": "viewer" }'
```

The publish answers `201` with the build — `{ id, files, bytes, message, by, created_at, warnings,
has_source, current }`. **Read `warnings`**: a non-empty list means the page will probably be blank.
Sharing answers `{ ok, outcome }` with `outcome` one of `granted`, `invited` (no account yet: an
invite waits for their first sign-in) or `removed` (`role: null`, or for an agent `agent_access`
with both off).

### 8.4 Publishing: the SDK

`tm.artifacts.publish()` zips the folder for you (Node, Deno, Bun); in a browser, or with files you
hold in memory, pass them as `[{ path, content }]` or `{ 'index.html': '…' }`, or pass the bytes of
a zip you already have.

```ts
import { createClient } from '{{url:sdk.ts}}';

const tm = createClient({ token: process.env.TM_TOKEN! });        // an account token, or an agent's

const art = await tm.artifacts.create({
  name: 'Sales dashboard',                                         // an agent creates it for its owner
  description: 'Weekly revenue by region, refreshed nightly',      // plain text, people and agents read it
  indicator: { kind: 'icon', icon: 'chart-line', color: '#22c55e' }, // optional: colour, icon or emoji
});
const build = await tm.artifacts.publish(art.id, './dist', { source: './', message: 'first cut' });
if (build.warnings.length) console.warn(build.warnings);

// sharing is the OWNER's: an account token, never an agent's
await tm.artifacts.share(art.id, { email: 'priya@example.com', role: 'viewer' });
await tm.artifacts.share(art.id, { agent: 'ag_0123456789abcdef', access: { build: false, data: 'write' } });
console.log(art.url);                                              // where people open it

// later
await tm.artifacts.rollback(art.id, olderBuildId);
const { url } = await tm.artifacts.source(art.id);                 // a short-lived link to the source zip
```

`source: './'` zips the project without `node_modules`, `.git`, `dist`, `build`, other build
caches, `.env` files and any file over 2 MB. The signatures, copied out of the published `sdk.d.ts`:

{{gen:artifactsdk}}

### 8.5 Publishing: MCP

```text
{{gen:artifacttools}}
```

`artifact_publish` takes **files, not a zip**: `files: [{ path, content, encoding? }]`, the whole
build in one call (it is not a patch), `encoding: 'base64'` for binaries. That covers a hand-written
HTML/CSS/JS artifact straight from a chat; a framework build goes through the SDK or REST from the
machine that built it. The four `artifact_data_*` tools are §8.10. Arguments for every tool are in
§5.3.

### 8.6 The driver: window.BackendDriver

An artifact never talks to Firebase and never holds a session. It loads one script, and that script
asks the TaskManager page around it to do each read and write, as the viewer, inside the artifact's
own prefix.

```html
<script src="{{url:driver.js}}"></script>
<script type="module">
  const db = window.BackendDriver;
  await db.ready;                                    // handshake done (calls made earlier simply wait for it)
  const me = db.me;                                  // { uid, name, email, photoURL, role, readOnly }
  const doc = await db.firestore.get('/my/doc');     // → { id, path, exists, data }
</script>
```

```text
{{url:driver.js}}      the script tag; sets window.BackendDriver
{{url:driver.mjs}}     the same as an ES module: import db from '…/driver.mjs'
{{url:driver.types}}   the types, one flat file with no imports
{{url:driver.latest}}  the newest build, never cached — pin v1 instead
{{url:driver.index}}                  the usage page, for people
```

What to know before writing one:

- **Paths are the artifact's own view.** `'/todos/a1'` and `'todos/a1'` are the same; `..` is
  refused. A Firestore **document** path has an even number of segments (`/todos/a1`), a
  **collection** an odd number (`/todos`, `/todos/a1/comments`). Collections may not be named
  `tickets` or `reads`, at any depth.
- **No `localStorage`, `sessionStorage`, `IndexedDB` or cookies.** The page runs in a sandboxed
  frame with an opaque origin, where those throw or do nothing. Use `db.kv` — per viewer, per
  artifact, and it follows the viewer across devices. `fetch` to public APIs and CDNs works (the
  origin is `null`).
- **Live listeners are real.** `onDoc`, `onList` and `rtdb.on` call back now and on every change by
  anyone the artifact is shared with; each returns an `unsubscribe()`.
- **Timestamps.** `db.serverTime` anywhere in a written value becomes the server's timestamp.
  Firestore timestamps arrive as `Date`, and a `Date` you write becomes a timestamp. In the Realtime
  Database both are milliseconds.
- **Errors** are rejected Promises (and `onError` callbacks) carrying `code`: `permission-denied`,
  `not-found`, `invalid-argument`, `quota`, `unavailable`.
- **Respect `db.me.readOnly`.** A viewer of a read-only artifact gets `permission-denied` on every
  write; hide the controls. `db.on('readonly', cb)` says when it changes, `db.on('revoked', cb)`
  when the viewer loses access, `db.on('build', cb)` when a newer build is published.
- **Not in v1:** transactions and batched writes, Firestore references and GeoPoints, field
  transforms other than `serverTime`, server-side code, sharing data between artifacts. (A batch
  exists — from outside the page, with a token: §8.10.)

**Board tickets (`db.tickets`).** An artifact can also work with the tickets of real boards — a
dashboard over a board, a custom intake form, a planning view — once its **owner** grants it the
board in the artifact's Settings › Board access (`artifactBoardAccessSet`, or the MCP tool
`artifact_board_access_set`), as **read** or **read & write**. The grant is a ceiling, not a key:
every call runs as the person looking, so they only ever see and change what their own role on that
board allows, and a viewer who is not on the board sees nothing of it. A board that was not granted
(or a write on a read grant) is `permission-denied`.

```js
const boards = await db.tickets.boards();          // granted boards this viewer can read: stages, fields, people, canWrite
const mine = await db.tickets.list('ENG', { assignee: 'me', orderBy: 'due' });
const off = db.tickets.onList('ENG', { stage: 'In review' }, (tickets) => render(tickets));
const t = await db.tickets.get('ENG-42');           // null when there is no such ticket
await db.tickets.create('ENG', { title: 'From the dashboard', priority: 'High', assignees: ['me'] });
await db.tickets.update('ENG-42', { stage: 'Done', dueAt: '2026-10-31' });
await db.tickets.comment('ENG-42', 'Shipped — see **v2**.');

// Read-only, on any granted board (read or write grant):
const msgs = await db.tickets.thread('ENG-42');                       // newest 50, oldest → newest (limit ≤ 200)
const older = await db.tickets.thread('ENG-42', { before: msgs[0].id }); // page back (or before: millis)
const offT = db.tickets.onThread('ENG-42', (msgs) => render(msgs));   // live: the newest window
img.src = await db.tickets.fileUrl('ENG-42', msgs[0].attachments[0].id);
const cost = await db.tickets.aggregates('ENG', { field: 'Cost' });   // { field, total, count, lifetime, buckets }
const offA = db.tickets.onAggregates('ENG', { field: 'Time', from: '2026-W30' }, (a) => chart(a.buckets));
```

Tickets come back with **names, not ids** (`stage.name`, `priority.name`, tag names, custom fields by
field name, select options by name), the description as **Markdown**, and times as **milliseconds**.
What you send takes names too (or ids), `'me'` and emails for people; an unknown name is
`invalid-argument` and the message lists the names that exist. Writes are refused for a viewer of a
read-only artifact, like every other write.

**Threads and aggregates.** A message is `{ id, kind: 'comment' | 'system' | 'question' | 'agg',
author, markdown, createdAt, editedAt, deleted, replyTo, pinned, attachments: [{ id, name, mime, size }],
question?, agg?, run? }` — a deleted message stays as a tombstone (`deleted: true`, empty `markdown`);
`question` is the form card with its `answer` (values by field label); `agg` is
`{ at?, entries: [{ fieldId, label, unit, value }] }`; `run` is a turn receipt `{ n, outcome, costUsd,
durationMs, model }`. Attachments carry no URL: ask `fileUrl(key, id)` when you need the bytes.
Boards carry `aggFields` (`[{ id, label, unit, period: 'daily' | 'weekly' | 'monthly', archived }]`) and
`aggs` (lifetime `{ [fieldId]: { total, count } }`); tickets carry their own `aggs`.
`aggregates(board, { field?, from?, to? })` answers one field's period buckets — `field` by id or label
(default the first active one), keys inclusive (`'2026-10-05'` · `'2026-W40'` · `'2026-10'`), `from`
defaulting to 30 days / 12 weeks / 12 months back — as `{ field, from, to, total, count, lifetime,
buckets: [{ key, total, count, tickets: { 'ENG-42': { total, count } } }] }`, oldest first, empty buckets
left out. Outside TaskManager the mock's DEMO board has a sample thread and a month of buckets.

**Memory files (`db.memory`).** A *memory* is a bucket of files — Markdown notes, images, video,
anything — that people keep in TaskManager and reuse across tickets and artifacts. The artifact's
**owner** grants it one of their memories in Settings › Memory (`memoryGrantSet`, or the MCP tool
`memory_grant_set`), as **read** or **read & write**. Again a ceiling: the page reaches a memory only
as far as the person looking can reach it themselves, and writes need both a write grant and the
viewer's own write access. Paths are relative to the memory (`docs/brand/logo.svg`); writing one
creates its missing folders.

```js
const [brand] = await db.memory.list();                 // { id, name, access: 'read' | 'write', files, bytes }
const nodes = await db.memory.tree(brand.id, 'docs');   // every folder and file under docs/
const md = await db.memory.read(brand.id, 'docs/README.md');
img.src = await db.memory.url(brand.id, 'logos/logo.png');
await db.memory.write(brand.id, 'notes/today.md', '# Today');   // ≤ 10 MB; a Blob works too
await db.memory.remove(brand.id, 'notes');                       // a folder goes with everything in it
```

The mock has one memory, `demo-memory`, with a `docs/README.md`.

The whole API:

{{gen:driver}}

### 8.7 On your machine: the mock

Opened **outside** TaskManager — `vite dev`, a file from disk — the driver says so in the console and
becomes a mock backend: the same API over a store kept in that browser's `localStorage` (uploaded
files last until the page reloads). `db.mock` is `true`, so the page can show a banner. An agent can
build and click through an artifact without publishing it.

```text
?role=owner|editor|viewer   who you are (default owner)
?readonly=1                 the artifact is read-only for viewers — and makes you a viewer if no role is given
?mock=1                     force the mock at once (a top-level page otherwise waits 1.5 s for a host),
                            and inside a preview pane that frames your page
```

The mock validates paths with the same rules as the real backend, so a path it accepts is one the
real one accepts. It does not imitate security rules beyond the read-only switch, indexes, or the
document size limit.

### 8.8 A complete artifact

One `index.html` is a whole artifact. This one is a shared to-do list: live for everyone it is shared
with, read-only aware, with a per-viewer preference in `db.kv`. Save it as `index.html` and publish
the folder — or, over MCP, pass it as the single file of `artifact_publish`.

{{gen:artifactexample}}

```ts
await tm.artifacts.publish(art.id, { 'index.html': html }, { message: 'shared to-do' });
```

### 8.9 A Vite project

For anything with a build step. The three things that must be right are already right here:
`base: './'`, the driver tag in `index.html` before the app module, and hash routing.

{{gen:artifactvite}}

```bash
npm install && npm run dev      # the mock backend, on localhost
npm run publish:artifact        # vite build, then publish dist/ with the project as its source
```

### 8.10 Data from outside the page

The driver is the page's way in: it works for whoever is looking at the artifact, while they are
looking. A job — a nightly import, an agent that refreshes a dashboard, a script — has no page. It
reaches **the same database and the same files** with a token:

```text
{{gen:artifactdatarest}}
```

**The page and the API see the same documents.** `PUT …/data/firestore/scores/2026` writes the
document `db.firestore.get('/scores/2026')` reads, and an open tab's `onDoc` / `onList` fires when a
job writes. So numbers no longer have to be baked into the build: do not ship a `seed.json` and
republish to change it — publish the page once, and write its data here.

**Who may.** An agent token whose agent has `data` on the artifact — `'read'` for the routes marked
so above, `'write'` for the rest (§8.2) — or an account token whose person is owner or editor. An
archived artifact answers its reads and refuses every write with `409`. An artifact the credential
cannot reach is `404`.

**Paths** are the artifact's own view, exactly as in the driver: the rest of the URL after
`/firestore/`, `/rtdb/` or `/files/`, each segment percent-encoded. A Firestore path with an even
number of segments is a **document**, an odd number a **collection** — the same `GET` reads one or
lists the other. `.` and `..` are refused.

**Values are JSON, with two escapes**, each an object with exactly one key:

```text
{ "$date": "2026-09-30T05:30:00Z" }   a timestamp. BOTH WAYS: written, it is stored as a Firestore
                                      timestamp; a stored timestamp is read back in this form. The
                                      page sees the same value through the driver as a Date.
{ "$serverTime": true }               in a WRITE only: the server's clock. Not inside an array.
```

Any other single-key object whose key starts with `$` is refused, so the escape space stays clean.
The Realtime Database has no timestamp type: there both are stored as epoch milliseconds.

Limits:

```text
{{gen:artifactdatalimits}}
```

#### With curl

```bash
A="{{url:apiBase}}/artifacts/$ID/data"
H="Authorization: Bearer $TM_TOKEN"

# one document: set (replace), merge, read
curl -s -X PUT "$A/firestore/meta/sales" -H "$H" -H 'Content-Type: application/json' \
  -d '{ "source": "warehouse", "refreshedAt": { "$serverTime": true } }'
curl -s -X PUT "$A/firestore/meta/sales?merge=1" -H "$H" -H 'Content-Type: application/json' \
  -d '{ "rows": 31 }'
curl -s "$A/firestore/meta/sales" -H "$H"
#   → { "id": "sales", "path": "/meta/sales", "exists": true,
#       "data": { "source": "warehouse", "rows": 31, "refreshedAt": { "$date": "2026-09-30T05:30:00.000Z" } } }

# a collection: filter, order, page.  where=field,op,value — repeat it; the value is JSON
# ("open" or open for a string, 100 for a number), and the whole parameter is URL-encoded
curl -s -G "$A/firestore/orders" -H "$H" \
  --data-urlencode 'where=status,==,open' \
  --data-urlencode 'where=total,>,100' \
  --data-urlencode 'order_by=total,desc' \
  --data-urlencode 'limit=50'
#   → { "data": [ { "id", "path", "exists", "data" }, … ], "next_cursor": "o_193" }   then start_after=o_193

# a file: the raw body IS the file
curl -s -X PUT "$A/files/exports/q3.csv" -H "$H" -H 'Content-Type: text/csv' --data-binary @q3.csv
curl -s "$A/files/exports/q3.csv" -H "$H"          # → { "url", "expires_at" }: a short-lived link
```

#### A nightly job that replaces a dataset

`POST …/data/batch` is what the driver does not have: up to the batch limit of `set` / `update` /
`delete` writes applied **all or nothing**. Nobody looking at the page sees a half-written dataset,
and a failed run leaves yesterday's numbers in place. This is the whole job, run by cron as an agent
with `{ build: false, data: 'write' }` on the artifact:

```ts
import { createClient, serverTime, ARTIFACT_DATA_LIMITS } from '{{url:sdk.ts}}';

declare function loadFromWarehouse(): Promise<{ day: string; total: number; orders: number }[]>;

const tm = createClient({ token: process.env.TM_TOKEN! });        // the agent's token
const data = tm.artifacts.data(process.env.ARTIFACT_ID!);

const rows = await loadFromWarehouse();
const keep = new Set(rows.map((r) => r.day));

// What is there now and should not be: stale days go in the same batch as the new ones.
const stale: string[] = [];
for await (const doc of data.firestore.listAll('sales')) if (!keep.has(doc.id)) stale.push(doc.id);

const writes = [
  ...rows.map((r) => ({ op: 'set' as const, path: `sales/${r.day}`, data: { ...r, day: new Date(r.day) } })),
  ...stale.map((id) => ({ op: 'delete' as const, path: `sales/${id}` })),
  { op: 'set' as const, path: 'meta/sales', data: { refreshedAt: serverTime, rows: rows.length } },
];
if (writes.length > ARTIFACT_DATA_LIMITS.batchWrites)
  throw new Error(`${writes.length} writes will not fit one atomic batch — keep fewer days, or one document per month`);

const { written } = await data.firestore.batch(writes);
console.log(`replaced the dataset: ${written} writes`);
```

The same batch over REST is one request:

```bash
curl -s -X POST "$A/batch" -H "$H" -H 'Content-Type: application/json' -d '{
  "writes": [
    { "op": "set",    "path": "sales/2026-09-29", "data": { "total": 1840, "day": { "$date": "2026-09-29T00:00:00Z" } } },
    { "op": "update", "path": "meta/sales",       "data": { "refreshedAt": { "$serverTime": true } } },
    { "op": "delete", "path": "sales/2025-09-29" }
  ] }'
#   → { "ok": true, "written": 3 }     an `update` of a missing document fails the WHOLE batch
```

A batch of `set` and `delete` is the same batch twice, so repeating one after a timeout is safe.
`POST` to a Firestore collection (add) honours `Idempotency-Key`: the same key is the same document.
`POST` to the Realtime Database (push) does not — a repeated push is a second child, so the SDK
does not retry that one call unless asked.

The page needs nothing new: its `db.firestore.onList('/sales', …)` callback runs when the batch
lands, with `day` as a `Date`.

#### The SDK

`tm.artifacts.data(id)` wraps every route above. A `Date` you write is sent as `$date` and a stored
timestamp comes back as a `Date`; `serverTime` is the server's clock. Pass `{ raw: true }` to get the
JSON exactly as the wire carries it. `list` answers `{ data, nextCursor }` and `listAll` pages for
you. The signatures, copied out of the published `sdk.d.ts`:

{{gen:artifactdatasdk}}

#### MCP

Firestore only — four tools, for a model that reads or fixes a few documents from a chat. Files and
the Realtime Database go through REST or the SDK.

```text
{{gen:artifactdatatools}}
```

They answer and take the wire's own JSON: timestamps are `{ "$date": … }` both ways.
