## 4. The loop — a complete orchestrator

This is the whole shape of the job:

```text
wait to be woken              →  one held connection, no traffic while idle
read the event inbox          →  an 'assigned' event names a ticket
pick up the work              →  get the ticket, its thread, its files
publish a plan                →  a task list, so people can watch it happen
heartbeat every minute        →  a live dot on the ticket: "Running tests (3/12)"
ask when you are blocked      →  a form card in the thread; the answer comes back typed
post the result with files    →  a Markdown message and an .html or .md document
mark it done                  →  finish the list, a final heartbeat, ack the event
```

**Wait — do not poll.** The first line is the one that costs money. An orchestrator that wakes every
30 seconds to ask "anything for me?" is, measurably, the most expensive thing on this platform: two
such loops were 88% of every request this API has ever served, and almost all of those requests
answered "no". Use `tm.work()` or `tm.watch()` and an idle agent makes **no requests at all** —
it holds one streaming connection to a Realtime Database node that only moves when something
actually changes, and only then asks for the delta. §4.5 says what to do if you are writing the
loop by hand.

Everything below runs as written. Set `TM_TOKEN` to the agent's token (§2), with the agent on the
board as an `editor`. If the agent is on more than one board, name the one this loop works on:
`createClient({ token, board: 'ENG' })`, or `?board=ENG` in the raw-REST version.

### 4.1 With the SDK, the short way

`tm.work()` is the loop: it **waits to be woken**, then asks for the events it has not seen
(`cursor` forward, `unacked` only), keeps a heartbeat alive while your handler runs, marks it
`done` or `error`, and acks the event only if the handler returned. Idle, it costs nothing — no
timer, no polling, no held function request.

```ts
import { createClient } from '{{url:sdk.ts}}';

declare function doTheWork(context: string): Promise<string>;  // your own code

const tm = createClient({ token: process.env.TM_TOKEN! });

const me = await tm.me();
// `board` is the one a call that names no board lands on — null when the agent is on several
// and this client was not given one (then pass `board: 'ENG'` to createClient).
console.log(`I am ${me.principal.name} (${me.role ?? 'no board named'}) on ${me.board?.key ?? (me.boards ?? []).map((b) => b.key).join(', ')}`);
console.log(me.principal.system_prompt ?? '(no system prompt — this token acts as a person)');

await tm.work(
  async ({ ticket, beat, tm }) => {
    if (!ticket) return;                                   // an event about no ticket in particular
    const t = await tm.tickets.get(ticket, { messages: 20 });

    // 1. Say what you intend to do, before doing it.
    const list = await tm.tasklists.set(ticket, {
      title: `Plan: ${t.title}`,
      items: ['Read the ticket', 'Do the work', 'Write the report'],
    });
    const step = (i: number, status: 'doing' | 'done' | 'failed', note?: string) =>
      tm.tasklists.item(ticket, list.id, list.items[i].id, { status, note });

    // 2. Work, and keep saying so.
    await step(0, 'doing');
    await beat?.update({ message: 'Reading the ticket', progress: 0.1 });
    const context = t.description_md ?? '';
    await step(0, 'done');

    await step(1, 'doing');
    await beat?.update({ message: 'Doing the work', progress: 0.5 });
    const findings = await doTheWork(context);             // your own code
    await step(1, 'done');

    // 3. Publish the result as a document, and point at it in the thread.
    await step(2, 'doing');
    const report = await tm.files.upload(ticket, {
      name: 'report.html',
      text: `<!doctype html><meta charset="utf-8"><h1>${t.key}</h1><pre>${findings}</pre>`,
    });
    await tm.messages.post(ticket, {
      markdown: [`**Done.** Here is what I found.`, '', findings.slice(0, 2000)].join('\n'),
      attachments: [report.id],
    });
    await step(2, 'done');
    await tm.tasklists.set(ticket, {
      listId: list.id,
      title: list.title,
      items: list.items.map((i) => ({ id: i.id, title: i.title, status: i.status })),
      closed: true,                                        // adds the "finished" line to the thread
    });
  },
  { filter: ['assigned', 'mentioned'], concurrency: 2 },
);
```

`work()` returns when the loop is stopped (`max`, an `AbortSignal`, or the process ending) with
`{ handled, failed, cursor }`. Keep the cursor if you want to resume somewhere else — passing it
back in as `{ cursor }` means a restart reads the delta, not the whole inbox.

The live connection is the one `GET /v1/live` hands out: a short-lived Realtime Database credential
for your token — `{ database_url, auth, expires_in, paths }` — where `paths` are exactly the nodes you
may stream (`rev/{boardId}`: something on the board changed; `agents/{agentId}/wake`: something is in
your inbox). `watch()` asks for it, opens `{database_url}/{path}.json?auth={auth}` as plain
Server-Sent Events for each path, and re-mints when it expires. Nothing about the change travels
through that stream; it only says *ask again*, and the delta call answers.

Where a live connection cannot be opened, `work()` falls back to polling on a backoff — a couple of
seconds while work is arriving, a minute when nothing is. You do not have to do anything for that;
it is the same call. To see which it is using, or to force polling:

```ts
await tm.work(handler, { watch: { poll: true, maxPollMs: 60_000 } });
```

### 4.2 With the SDK, the loop written out

Use this shape when you want the control: your own filtering, your own acks, your own recovery. It
is the same economy as `work()` — sleep on `tm.watch()`, wake on a change, fetch the delta.

```ts
import { createClient, isTmError } from '{{url:sdk.ts}}';

const tm = createClient({ token: process.env.TM_TOKEN! });

const watcher = tm.watch();          // ONE held connection; nothing while idle
let cursor: string | undefined = process.env.TM_CURSOR;  // persist this between runs

for await (const signal of watcher) {
  // `signal.reason` is 'open' (just started), 'inbox' / 'board' (something moved)
  // or 'poll' (the backstop, or the polling fallback).
  const page = await tm.events.list({ cursor, unacked: true });
  cursor = page.next_cursor ?? cursor;
  watcher.found(page.data.length);   // 0 ⇒ back off; >0 ⇒ stay eager

  for (const ev of page.data) {
    if (ev.type !== 'assigned' || !ev.ticket_key) continue;
    const key = ev.ticket_key;

    const beat = tm.heartbeat.start({ ticket: key, message: 'Picking this up' });
    try {
      const t = await tm.tickets.get(key, { messages: 50 });

      // Blocked? Ask, and wait for a person. The card locks once answered.
      const answer = await tm.questions
        .ask(key, {
          title: 'Which database should the report use?',
          body: 'I can read either; the numbers differ slightly.',
          blocking: true,
          fields: [
            { id: 'db', label: 'Database', type: 'single', options: ['Postgres', 'SQLite'], required: true },
            { id: 'notes', label: 'Anything I should know?', type: 'longText' },
          ],
        })
        .waitForAnswer({ timeoutMs: 30 * 60_000 });

      await beat.update({ message: `Using ${answer.values.db}`, progress: 0.4 });
      const plan = await tm.files.upload(key, { name: 'plan.md', text: `# Plan for ${t.key}\n\n- …` });
      await tm.messages.post(key, { markdown: `Plan attached. Using **${answer.values.db}**.`, attachments: [plan.id] });

      await beat.done({ message: 'Finished' });
      await tm.events.ack([ev.id]);
    } catch (e) {
      if (isTmError(e) && e.code === 'gone') {
        // the question was cancelled or expired — nothing to do here
        await beat.stop();
      } else {
        await beat.error(e instanceof Error ? e.message : String(e));
      }
      // NOT acked: it comes back in the next delta, because `unacked` is on.
    }
  }
}
```

⚠ **`tm.events.stream()` is the expensive door.** It is a real Server-Sent Events feed and it still
works, but holding it open holds a request open inside the API function — and that function is
billed for a request's whole life, waiting included. An always-connected agent on
`/v1/events/stream` is the single most expensive way to use this API. Reach for it only inside a
short-lived process that genuinely wants a push feed; for anything long-running, use `tm.watch()`.

### 4.3 Watching a BOARD, not just your inbox

The same watcher covers "did anything on this board change?", and `tm.tickets.changes()` is the
matching read: it remembers the newest `updated_at` it handed you and sends it as `updated_since`,
so an unchanged board answers with an empty page.

```ts
const tm = createClient({ token: process.env.TM_TOKEN! });
const watcher = tm.watch({ target: 'board' });

for await (const _ of watcher) {
  const changed = await tm.tickets.changes();     // only what moved since last time
  for (const t of changed) console.log(t.key, t.stage.name, t.updated_at);
  watcher.found(changed.length);
}
```

`tm.tickets.watermark()` hands you the timestamp it will ask from next, so a process that restarts
can persist it and resume without rescanning. Never run `tm.tickets.list()` with no
`updated_since` on a timer: that is a full scan of the board, every time, forever.

### 4.4 The same loop in raw REST

No SDK, no dependencies — just `fetch` and a token. This is the complete equivalent of §4.1 and runs
on Node 20+, Deno or Bun. It cannot hold the live connection the SDK does, so it does the next best
thing: **it backs off**. Read §4.5 before you change the timings.

```js
const BASE = '{{url:apiBase}}';
const TOKEN = process.env.TM_TOKEN;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const uid = () => crypto.randomUUID();

/** One request, with the retry rules of §6 applied. */
async function api(method, path, body, idempotencyKey) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...H, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    const problem = await res.json().catch(() => ({ code: 'internal', title: res.statusText }));
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) throw Object.assign(new Error(problem.detail ?? problem.title), problem);
    const after = Number(res.headers.get('retry-after')) * 1000;
    await new Promise((r) => setTimeout(r, after || 2 ** attempt * 500 + Math.random() * 250));
  }
}

// 0. Who am I? (An agent token also answers with its system prompt.)
const me = await api('GET', '/me');
console.log(me.principal.name, '·', me.kind, '·', me.board?.key ?? (me.boards ?? []).map((b) => b.key).join(', '));

// 1. The inbox, from a cursor you persist between runs. ALWAYS `unacked=1`,
//    ALWAYS from the cursor: this asks for the delta, never for the world.
let cursor = null;
let idleMs = 2_000;                       // seconds while work is arriving …
const MAX_IDLE_MS = 60_000;               // … a minute when there is none
for (;;) {
  const page = await api('GET', `/events?limit=50&unacked=1${cursor ? `&cursor=${cursor}` : ''}`);
  cursor = page.next_cursor ?? cursor;
  idleMs = page.data.length ? 2_000 : Math.min(MAX_IDLE_MS, idleMs * 2);

  for (const ev of page.data) {
    if (ev.type !== 'assigned' || !ev.ticket_key) continue;
    const KEY = ev.ticket_key;

    // 2. Say you are alive, every minute, while you work.
    const beat = setInterval(
      () => api('POST', '/heartbeat', { ticket: KEY, state: 'working', message: 'Working' }).catch(() => {}),
      60_000,
    );
    await api('POST', '/heartbeat', { ticket: KEY, state: 'working', message: 'Picking this up', progress: 0 });

    try {
      const ticket = await api('GET', `/tickets/${KEY}?messages=20`);

      // 3. Publish the plan.
      const listId = uid();
      const list = await api('PUT', `/tickets/${KEY}/tasklists/${listId}`, {
        title: `Plan: ${ticket.title}`,
        items: [{ title: 'Read the ticket' }, { title: 'Do the work' }, { title: 'Write the report' }],
      }, uid());
      const item = (i, patch) =>
        api('PATCH', `/tickets/${KEY}/tasklists/${listId}/items/${list.items[i].id}`, patch, uid());

      await item(0, { status: 'done' });
      await item(1, { status: 'doing' });
      await api('POST', '/heartbeat', { ticket: KEY, state: 'working', message: 'Doing the work', progress: 0.5 });

      // 4. Upload a document and post it. `text` is all an .md or .html report needs.
      const file = await api('POST', `/tickets/${KEY}/files`, {
        name: 'report.html',
        text: `<!doctype html><meta charset="utf-8"><h1>${ticket.key}</h1><p>All good.</p>`,
      }, uid());
      await item(1, { status: 'done' });
      await item(2, { status: 'done' });

      await api('POST', `/tickets/${KEY}/messages`, {
        body_markdown: '**Done.** The report is attached.',
        attachments: [file.file_id],
      }, uid());

      // 5. Stop the dot, and only now acknowledge the event.
      await api('POST', '/heartbeat', { ticket: KEY, state: 'done', message: 'Finished' });
      await api('POST', '/events/ack', { ids: [ev.id] }, uid());
    } catch (e) {
      await api('POST', '/heartbeat', { ticket: KEY, state: 'error', message: String(e).slice(0, 200) });
      // left unacked on purpose: it comes back next time round
    } finally {
      clearInterval(beat);
    }
  }

  await new Promise((r) => setTimeout(r, idleMs));
}
```

`GET /v1/events/stream` is the same feed as Server-Sent Events from a cursor (it ends about every 50
seconds — reconnect, that is normal), but see the warning in §4.2 before you hold it open: it is
billed for every second it stays open. A board admin can point a **webhook** at your service
instead, which costs you nothing at all while nothing is happening.

### 4.5 What the loop costs

Measured over three days on this very deployment: **88% of all API requests were two orchestrator
polling loops**, each running every ~30 seconds, each asking for everything (`GET /v1/tickets` with
`limit=200` and no `updated_since`; `GET /v1/events` with `unacked=1` and no cursor) whether or not
anything had changed. The API function spent 87% of its billable CPU simply waiting.

So, in order of how much they save:

1. **Wait, do not poll.** `tm.work()` / `tm.watch()` hold one connection to a Realtime Database node
   that the server bumps when something changes. That connection is held by Google's edge, not by a
   function, and the RTDB bills bandwidth rather than time. Idle: zero requests.
2. **Ask for the delta.** `cursor` + `unacked=1` on the inbox; `updated_since` on tickets
   (`tm.tickets.changes()` does it for you). An unchanged board should answer with an empty page.
3. **If you must poll, back off.** A couple of seconds while work is arriving, a minute when it is
   not. Never a fixed short interval.
4. **Do not hold `/v1/events/stream` open forever.** It is billed for its whole life. It is there
   for short-lived push-shaped processes, not for always-on agents.

There are no rate limits on this API — it is a private deployment and its owner's own agents are the
only callers. That is exactly why these four rules are on you: nothing will stop a runaway loop
except the person reading the bill.

### 4.6 Say what a run cost: the turn receipt

One run of the agent is one turn (`claude -p` started once, exiting with one result line). When it
exits, post **one message** on the ticket carrying `run` beside the Markdown — the turn receipt:

```ts
await tm.messages.post(ticket.key, {
  markdown: `Turn ${n} · ${outcome} · $${cost.toFixed(2)} · ${Math.round(ms / 60000)} min`,
  run: { n, outcome, costUsd: cost, sessionUsd: reported, durationMs: ms, apiTurns, model, usage },
});
```

`outcome` is one of `review`, `waiting`, `blocked`, `failed`, `stopped`, `timeout`. **Per turn, not
per session**: Claude Code reports `total_cost_usd` cumulatively across a resumed session, so keep
the last reported total in your state and post the *difference* as `costUsd` (the reported total goes
in `sessionUsd`). A run that dies without a result line has no receipt; its money shows up in the next
turn's difference, which is honest — it was spent on this ticket. The server stores the receipt on
the message and, in the same write, adds `costUsd` to the board's **Cost aggregate field** (id
`cost`, unit `$`, daily): the ticket's `aggs.cost`, the board's `aggs.cost` and the day's bucket the
board's Analytics view draws. The receipt comes back with `agg: { entries: [{ field_id: 'cost',
value: costUsd }] }`; the old `cost: { usd, runs }` on the ticket and the board is still there,
computed from it. The body is the same thing in words, so digests and search see it too. Only the
orchestrator posts receipts; the app's composer never does.

**Other totals.** Cost is one aggregate field among any the board defines (board settings ›
Aggregates: a label, a unit, a period of `daily`, `weekly` or `monthly`). Read them from the board's
`agg_fields`; add to them with a message carrying `agg` — kind `agg`, one entry per field, a
negative value takes away. Name a field by `field_id` or by its label (`field`, case-insensitive);
`body` may be left out (the server writes *"+2.5 h Time"*):

```ts
await tm.messages.post(ticket.key, {
  markdown: 'Pairing session with the reviewer',
  agg: { entries: [{ field: 'Time', value: 2.5 }] },
});
```

```bash
curl -X POST "$TM/v1/tickets/ENG-42/messages" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: time-ENG-42-7' \
  -d '{ "agg": { "entries": [{ "field": "Time", "value": 2.5 }] } }'
```

MCP: `post_message` with the same `agg`. An unknown or archived field is a `400`. An entry is never
edited or deleted — correct a mistake with another entry (`-0.5`). A receipt may carry other entries
too, but not one on `cost` (its `costUsd` already is). The ticket's totals are `aggs` on the ticket,
the board's lifetime totals `aggs` on the board, and the buckets of one field are
`GET /v1/boards/{KEY}/aggregates?field=Time&from=2026-W30&to=2026-W41` → `{ field, total, buckets:
[{ key, total, count, tickets: { KEY: { total, count } } }] }` (`from` / `to` are period keys —
`2026-10-05`, `2026-W41`, `2026-10` — inclusive; default the last 30 days / 12 weeks / 12 months).
The SDK: `tm.aggregates({ field: 'Time', from: '2026-W30' })`; MCP: `get_aggregates`.

### 4.7 The rules this example is obeying

- **Ack last.** An event stays in the inbox until you acknowledge it, so a crash mid-job means the
  work comes back rather than vanishing.
- **Heartbeat while you work.** Silence for more than 75 seconds turns the ticket's dot red, and
  after five minutes the agent's owner is told. A final `done` or `error` beat closes it out cleanly.
- **Publish the plan before doing it.** The task list is how a person watches an agent work without
  interrupting it.
- **Ask instead of guessing.** A blocking question puts *"❓ Waiting for you"* on the ticket and
  notifies the right people through their own channels.
- **Every write carries an idempotency key.** A retried request is still one change.
- **Wake, do not poll, and ask for the delta.** See §4.5 — it is the difference between an idle
  orchestrator costing nothing and costing more than everything else put together.
