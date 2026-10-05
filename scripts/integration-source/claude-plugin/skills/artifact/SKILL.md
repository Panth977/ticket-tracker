---
name: artifact
description: How to build, run locally, publish and share a TaskManager artifact — a small website (dashboard, tracker, form, poll, tool) that lives inside TaskManager with its own database behind one script tag, window.BackendDriver — and how to read or write that database from OUTSIDE the page with a token (the data API). Use whenever the user asks for an artifact, a small app or page "in TaskManager", something a few people should open and use together, wants an artifact's data loaded, refreshed, imported or fixed, or mentions BackendDriver, /x/{id}, artifact_publish, artifact_data_*, or tm.artifacts.
---

# TaskManager artifacts

Version {{VERSION}} · updated {{UPDATED}} · this deployment: {{HOST}}

An **artifact** is a static website kept and served by TaskManager: you write the frontend, publish the
folder, share it. It has its own people and its own data, and it is **not** on a board. People open it at
`{{url:artifactsUrl}}{id}`, signed in; there is no public link.

Bundled beside this file — copy them rather than retyping:

```text
example/index.html     a complete single-file artifact: a live, shared to-do list
template/              a Vite project with base './', the driver tag and hash routing already right,
                       and publish.mjs (build → publish with the source → print the URL)
```

The full reference — every REST route, every tool argument, the driver's whole type file — is §8 of
`../taskmanager/reference/llms-full.txt`, live at {{url:llmsFullUrl}}.

## The five steps

```text
1. scaffold     one index.html (small things), or the Vite template (anything with a build step)
2. driver       <script src="{{url:driver.js}}"></script>, then window.BackendDriver
3. run locally  open it outside TaskManager: the driver becomes a mock backend — click through it
4. publish      artifact_publish (inline files, ≤ 5 MB) · or tm.artifacts.publish(id, './dist') · or REST
5. share        artifact_share — then give the user the artifact's url
6. data         only when something OUTSIDE the page must read or write the data: the data API (§6)
```

## 1 · Scaffold

**Plain HTML** is the default. If it fits in one file, write one `index.html` with inline CSS and a
`<script type="module">` — start from `example/index.html`.

**Vite** (Svelte, React, Vue, plain) when there is a real build: copy `template/`. Three things must hold,
whatever the framework:

- `base: './'` in `vite.config.js`. The page is served under a prefix that changes, so asset URLs must be
  relative. The default (`/assets/app.js`) publishes, answers with a warning, and shows a **blank page**.
- **Hash routing** (`#/settings`), or a single page. Not the History API.
- An `index.html` at the root of what you publish — `dist/`, never the project folder.

## 2 · The driver

```html
<script src="{{url:driver.js}}"></script>
<script type="module">
  const db = window.BackendDriver;
  await db.ready;
</script>
```

Or as a module, in a bundled project: `import db from '{{url:driver.mjs}}'`. Types:
`{{url:driver.types}}` — one flat file; save it as `src/backend-driver.d.ts` and `window.BackendDriver` is
typed. The driver contains no Firebase and needs no configuration: the TaskManager page around the artifact
does every read and write, as the viewer, inside this artifact's own prefix.

```text
db.ready                    a Promise: the handshake is done. Calls made before it simply wait.
db.me                       { uid, name, email, photoURL, role: 'owner'|'editor'|'viewer', readOnly }
db.artifact                 { id, name, buildId }
db.mock                     true when running outside TaskManager, on the mock backend
db.serverTime               put it anywhere in a value you write: it becomes the server's timestamp

db.firestore  .get(path)                       → { id, path, exists, data }
              .set(path, data, { merge? })   .update(path, patch)   .delete(path)
              .add(collection, data)           → { id, path }
              .list(collection, { where: [[field, op, value]…], orderBy: [field, 'asc'|'desc'], limit, startAfter })
              .onDoc(path, cb, onError?)       → unsubscribe()
              .onList(collection, query, cb, onError?)   → unsubscribe()     LIVE

db.rtdb       .get(path)  .set(path, v)  .update(path, patch)  .push(path, v)  .remove(path)
              .on(path, cb, onError?)          → unsubscribe()     the whole subtree, live

db.storage    .upload(path, blob, { contentType? })   → { path, size }
              .url(path)                       → a short-lived URL for <img src>, <a href>
              .list(prefix)  .delete(path)

db.kv         .get(key)  .set(key, value)  .delete(key)      per viewer, per artifact

db.tickets    .boards()                        → granted boards: { key, name, access, canWrite, stages, priorities, tags, fields, members }
              .list(board, { stage?, assignee?: 'me'|email|null, state?, orderBy?: 'rank'|'updated'|'created'|'due', limit? })
              .onList(board, query, cb, onError?)   → unsubscribe()     LIVE
              .get('ENG-42')                   → ticket | null   (names not ids, Markdown description, millis)
              .create(board, { title, description?, stage?, priority?, tags?, assignees?, dueAt?, fields? })   → { id, key }
              .update('ENG-42', patch)   .comment('ENG-42', markdown)
              Only boards the OWNER granted (Settings › Board access, read or read & write); always as the viewer.

db.memory     .list()                          → granted memories: { id, name, description, icon, access: 'read'|'write', files, bytes }
              .tree(memory, path?)             → [{ id, kind: 'folder'|'file', path, name, mime, size, updatedAt }]
              .read(memory, 'docs/a.md')       → text (≤ 1 MB)      .url(memory, 'img/logo.png') → short-lived URL
              .write(memory, path, text | Blob, { contentType? })   (≤ 10 MB, parents created)
              .mkdir(memory, path)   .remove(memory, path)          (a folder goes with everything in it)
              Only memories the OWNER granted (Settings › Memory, read or read & write); always as the viewer.

db.on('readonly' | 'revoked' | 'build', cb)    → unsubscribe()
```

### The rules of the sandbox

- **No `localStorage`, `sessionStorage`, `IndexedDB` or cookies.** The artifact runs in a sandboxed frame
  with an opaque origin; those throw or do nothing. Anything you would have kept there goes in **`db.kv`**
  (it also follows the viewer across devices).
- **Paths are relative to the artifact.** `'/todos/a1'` and `'todos/a1'` are the same; `..` is refused. You
  never see, and cannot leave, the prefix. A Firestore **document** has an even number of segments
  (`/todos/a1`), a **collection** an odd number (`/todos`).
- **Collections named `tickets` or `reads` are refused**, at any depth. Call them something else (`items`,
  `seen`).
- **Live, not polled.** Use `onList` / `onDoc` / `rtdb.on` and re-render in the callback. Keep the
  `unsubscribe()` when a view goes away — a tab may hold 50 listeners.
- **`where` with `orderBy` on a different field needs an index that an artifact cannot create.** Filter on
  one field and sort in the page, or order by the field you filter on.
- **Respect `db.me.readOnly`.** Writes then fail with `permission-denied`: hide the controls, and listen to
  `db.on('readonly', …)` because it can change while the page is open.
- **Errors** are rejected Promises with `code`: `permission-denied`, `not-found`, `invalid-argument`,
  `quota`, `unavailable`. `update()` on a missing document is `not-found`; use `set(…, { merge: true })`.
- **Render other people's text with `textContent`**, never `innerHTML`. Everything in the database was
  typed by someone the artifact is shared with.
- `fetch` to public APIs and CDNs works. There is no server-side code, no transactions, no batched writes
  in the driver. (An atomic batch exists from outside the page: §6.)
- Limits: a document 256 KB, an upload 25 MB, `list` 500 documents at most (100 by default).

## 3 · Run it locally

Open the page **outside** TaskManager — a file from disk, `npx vite`, any static server. After about a
second and a half the driver says so in the console and becomes a **mock backend**: the same API over a
store in that browser's `localStorage`. Build the whole thing against it and click through it before
publishing.

```text
?mock=1       become the mock at once (and inside a preview pane that frames your page)
?role=viewer  be an owner (default), editor or viewer
?readonly=1   the artifact is read-only for viewers — alone, it also makes you a viewer
```

Check at least: a fresh load with no data, a write appearing through the live listener, and `?readonly=1`
hiding the controls. The mock uses the real path rules, so a path it accepts is one the real backend accepts.

## 4 · Publish

Creating an artifact needs `artifacts:write`. With an **account** credential it is yours. With an **agent's**
token it is created for the agent's **owner** — they own it and see it in their sidebar at once — and the
agent is on it with `{ build: true, data: 'write' }`, so it can publish straight away and write its data
(but never share, rename or delete it).

**What an agent may do on an artifact is two permissions, given by the owner, separately:**

```text
build   true | false               publish, roll back, download the source
data    'none' | 'read' | 'write'  the artifact's database and files, through the data API (§6)
```

`artifact_get` states yours as `agent_access` (ignore `role`: it reads `editor` for every agent). An agent's
token always carries both artifact scopes, so a **403 is never a missing scope**: on publish or rollback it
means `build` is off; on a data call, that `data` is `none` (or `read`, for a write). Say which, and that the
owner changes it on the agent's page ({{url:agentsUrl}}) or with `artifact_share`. A person's token that gets
a 403 on create lacks `artifacts:write`.

**From a chat — the MCP tools.** For hand-written HTML/CSS/JS, at most 5 MB:

```text
artifact_create   { name, description?, icon? }                    → { id, url, … }
artifact_publish  { id, files: [{ path, content, encoding? }], message? }
```

`files` is the **whole build, not a patch** — every file, every time, with `index.html` at the root.
`encoding: 'base64'` for images and other binaries. The answer is the build, with `warnings` and the `url`.

**From a machine that built it — the SDK.** For a `dist/` folder of any size up to the limits:

```js
import { createClient } from '{{url:sdk.esm}}';

const tm = createClient({ token: process.env.TM_TOKEN, baseUrl: '{{HOST}}' });
const art = await tm.artifacts.create({ name: 'Sales dashboard' });
const build = await tm.artifacts.publish(art.id, './dist', { source: './', message: 'first cut' });
console.log(build.warnings, art.url);
```

`'./dist'` is walked and zipped for you. `source` is optional and worth sending: the project goes up beside
the build (without `node_modules`, `.git`, `dist`, `.env` files), and `artifact_source` /
`tm.artifacts.source(id)` hands it to whoever carries on. `template/publish.mjs` is this, ready to run.

**Or REST**, from anything: `POST {{url:apiBase}}/artifacts/{id}/builds?message=…` with the zip of the
build folder's *contents* as the body (`Content-Type: application/zip`), or multipart with parts `build`
and `source`.

Limits: 25 MB and 2,000 files unpacked, a 26 MB zip, 31 MB for the whole request.

**Always read `warnings`** in the answer. A warning about absolute asset paths means the page is blank:
fix `base: './'`, rebuild, publish again. Every publish is a new build and is live at once; the data is
never touched. `artifact_rollback { id, build }` makes an earlier build current again (`artifact_get` lists
them).

## 5 · Share

```text
artifact_share { id, email, role: 'viewer' | 'editor' }     a person — invited if they have no account yet
artifact_share { id, email, role: null }                    remove a person
artifact_share { id, agent: 'ag_…', agent_access: { build: true, data: 'write' } }    one of the owner's agents:
                                                            build and data, separately
artifact_share { id, agent: 'ag_…', agent_access: { build: false, data: 'none' } }    remove an agent
```

Owner only — **an agent can never share**, whatever it may do on the artifact; ask the owner. Give an agent
the least that does the job: a job that refreshes numbers needs `{ build: false, data: 'write' }`, a report
reader `{ build: false, data: 'read' }`, the agent that maintains the page `build: true`. A **viewer** can open it and — unless the artifact is set read-only — write its data, because a
poll or a checklist nobody can fill in is useless. An **editor** can also publish. Then tell the user the
artifact's `url`: that page is the only place it runs.

## 6 · The data, from outside the page

The driver works for whoever is **looking at** the artifact. When something else must touch the data — you,
in this chat; a nightly import; an agent refreshing a dashboard — use the **data API**: the artifact's own
Firestore, Realtime Database and files, reached with a token. **The page and the API see the same
documents**, so a write here shows up in every open tab through its `onDoc` / `onList` listeners.

**Which to use:**

```text
the page, for the person in front of it      the DRIVER. Live listeners, db.me, db.kv. No token anywhere.
  (a form, a vote, a checklist, a filter)     Never put a token in a published artifact: everyone it is
                                              shared with can read its source.
anything with no page open                   the DATA API, with a token.
  (import, nightly refresh, backfill,         Needs `data` on the artifact: 'read' to read, 'write' to write
   a fix, reading results into a ticket)      (an agent), or owner / editor (a person's account token).
numbers a dashboard shows                    write them with the data API; the page reads them with the
                                              driver. Do NOT bake a seed.json into the build and republish
                                              to change it — a build is code, the database is data.
```

From a chat, the four MCP tools (Firestore only):

```text
{{gen:artifactdatatools}}
```

```text
artifact_data_get   { id, path: 'meta/sales' }                        → { id, path, exists, data }
artifact_data_list  { id, path: 'orders', where: [['status','==','open']], order_by: 'total,desc', limit: 50 }
                                                                      → { data: [...], next_cursor } → start_after
artifact_data_set   { id, path: 'meta/sales', data: { rows: 31 }, merge: true }
artifact_data_batch { id, writes: [ { op: 'set', path, data, merge? } | { op: 'update', path, data } | { op: 'delete', path } ] }
```

- **Paths** are the artifact's own view, as in the driver: `orders/o1` is a document (even segments),
  `orders` a collection (odd). `..` is refused; collections named `tickets` or `reads` are refused.
- **Timestamps are JSON escapes.** Write `{ "$date": "2026-09-30T05:30:00Z" }` for a timestamp and
  `{ "$serverTime": true }` for the server's clock (not inside an array); a stored timestamp is read back as
  `{ "$date": … }`. The page sees the same value as a `Date`. Do not store dates as strings when the page
  sorts or filters on them.
- **`artifact_data_batch` is all or nothing** — up to 400 writes. It is how a dataset is *replaced*: the new
  rows, the deletes of the stale ones and the "refreshed at" stamp in one call, so nobody sees it half done.
  An `update` of a missing document fails the whole batch; use `set` with `merge: true` when unsure.
- **Read before you overwrite.** `artifact_data_set` without `merge` replaces the document. `list` first when
  you are about to delete.
- Limits: 400 writes per batch, 500 documents per list page (100 by default), 10 filters, a document 1 MiB,
  a file 25 MB. An archived artifact refuses writes (409).

From a machine — a job, a script — the SDK wraps all of it, files and the Realtime Database included:

```js
import { createClient, serverTime } from '{{url:sdk.esm}}';

const tm = createClient({ token: process.env.TM_TOKEN, baseUrl: '{{HOST}}' });   // an agent with data: 'write'
const data = tm.artifacts.data(process.env.TM_ARTIFACT);

const stale = [];
for await (const doc of data.firestore.listAll('sales')) if (!rows.some((r) => r.day === doc.id)) stale.push(doc.id);

await data.firestore.batch([                                   // ≤ 400 writes, atomic
  ...rows.map((r) => ({ op: 'set', path: `sales/${r.day}`, data: { ...r, day: new Date(r.day) } })),
  ...stale.map((id) => ({ op: 'delete', path: `sales/${id}` })),
  { op: 'set', path: 'meta/sales', data: { refreshedAt: serverTime, rows: rows.length } },
]);

await data.files.upload('exports/q3.csv', csv, { contentType: 'text/csv' });
```

In the SDK a `Date` is a timestamp both ways and `serverTime` is the server's clock; `list` answers
`{ data, nextCursor }` and `listAll` pages. Over REST it is `{{url:apiBase}}/artifacts/{id}/data/firestore/{path}`
(`GET` / `PUT ?merge=1` / `PATCH` / `DELETE` / `POST`), `/data/batch`, `/data/rtdb/{path}` and
`/data/files/{path}` — §8.10 of `../taskmanager/reference/llms-full.txt` has every route, with curl.

## The tools

```text
{{gen:artifacttools}}
```

## When something goes wrong

```text
blank page after publishing       absolute asset paths — the build's `warnings` said so. base: './'
"no index.html"                   you published the project, not the build folder (or zipped the folder
                                  itself inside another folder two levels deep)
localStorage throws               it does not exist here — db.kv
permission-denied on a write      the viewer is read-only (db.me.readOnly), or the artifact is archived
invalid-argument on a path        odd/even segments, '..', or a collection named tickets / reads
403 on artifact_create            a person's token without the artifacts:write scope (an agent MAY create one:
                                  it is made for its owner)
403 on publish / rollback         an agent without `build` on this artifact — the owner gives it (§5)
403 on an artifact_data_* call    an agent whose `data` here is 'none' (or 'read', for a write) — the owner
                                  changes it
403 "a board token cannot reach   a person's BOARD token: artifacts need an account token (or an agent's)
     artifacts"
403 on artifact_share             you are not the owner — an agent never shares
409 on a data write               the artifact is archived
404 on an artifact                it is not shared with this credential (existence is never leaked)
413 too_large                     over 25 MB / 2,000 files unpacked, or 5 MB inline over MCP — use the SDK
the page never leaves "Connecting"  it is framed by something that is not TaskManager — add ?mock=1
```
