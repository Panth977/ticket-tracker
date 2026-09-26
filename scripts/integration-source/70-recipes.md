## 7. Recipes

Five shapes that cover most of what orchestrators actually do. All of them use the SDK; each one is
a handful of REST calls if you prefer (§5.2).

### 7.1 Triage a board

Read everything in the first column, decide, and move it — without ever touching a ticket somebody
else is already on.

```ts
const board = await tm.board();
const inbox = board.stages.find((s) => s.category === 'backlog')!;
const next = board.stages.find((s) => s.category === 'todo')!;

for await (const t of tm.tickets.iterate({ stage: inbox.id, state: 'active' })) {
  if (t.assignees.length) continue;                     // somebody already owns it
  const full = await tm.tickets.get(t.key, { messages: 10 });

  const verdict = await classify(full);                 // your model call
  await tm.tickets.update(t.key, {
    priority: verdict.priority,                         // by NAME: 'High'
    tags: [...t.tags, ...verdict.tags],
    fields: { Component: verdict.component },           // custom fields by NAME too
  });
  await tm.tickets.move(t.key, next.id);
  await tm.messages.post(t.key, { markdown: `Triaged: **${verdict.priority}** — ${verdict.why}` });
}
```

Stages, priorities, tags and custom fields can all be named rather than referenced by id. Read the
board once at startup; it changes rarely.

### 7.2 Answer-driven work

Do not guess at a fork in the road. Ask, and let the person's answer choose the branch.

```ts
const answer = await tm.questions
  .ask(key, {
    title: 'How should I handle the legacy rows?',
    body: 'About 4 000 rows predate the schema change.',
    blocking: true,                                     // puts "❓ Waiting for you" on the ticket
    to: ['priya@example.com'],                          // omit to ask anyone on the board
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    fields: [
      { id: 'how', label: 'Do what?', type: 'single', required: true,
        options: [
          { id: 'migrate', label: 'Migrate them', description: 'Slower, keeps history' },
          { id: 'drop', label: 'Drop them' },
          { id: 'skip', label: 'Leave them alone' },
        ] },
      { id: 'why', label: 'Anything I should know?', type: 'longText' },
    ],
  })
  .waitForAnswer({ timeoutMs: 6 * 3600_000 });

switch (answer.values.how) {                            // typed from the fields you passed
  case 'migrate': await migrate(); break;
  case 'drop':    await drop();    break;
  default:        break;
}
```

While you wait, send an `idle` heartbeat so the ticket shows *"Idle · waiting for an answer"* rather
than a stale green dot:

```ts
await tm.heartbeat.send('idle', { ticket: key, message: 'Waiting for an answer' });
```

If nobody answers, `waitForAnswer` throws `TmError` with code `timeout`; if the question is
cancelled or expires, `gone`. An answer also arrives as the inbox event `question_answered`, values
included — so a *stateless* orchestrator can ask, exit, and pick the answer up on a later run
instead of blocking.

### 7.3 A long job with visible progress

```ts
const beat = tm.heartbeat.start({ ticket: key, message: 'Starting' });
const list = await tm.tasklists.set(key, { title: 'Migration', items: steps.map((s) => s.title) });

try {
  for (const [i, step] of steps.entries()) {
    await tm.tasklists.item(key, list.id, list.items[i].id, { status: 'doing' });
    await beat.update({ message: `${step.title} (${i + 1}/${steps.length})`, progress: i / steps.length });
    try {
      await step.run();
      await tm.tasklists.item(key, list.id, list.items[i].id, { status: 'done' });
    } catch (e) {
      // A failed item is red on the ticket, with your note next to it.
      await tm.tasklists.item(key, list.id, list.items[i].id, { status: 'failed', note: String(e).slice(0, 500) });
      throw e;
    }
  }
  await beat.done({ message: 'Migration finished' });
} catch (e) {
  await beat.error(String(e).slice(0, 200));
  throw e;
}
```

A person watching sees a progress bar (`4 / 7`), a spinner on the item in flight, a `4/7` chip on
the board card, and a live green dot with your message. They never have to ask how it is going.

### 7.4 Publish an HTML report

The app renders an uploaded `.html` file in a sandboxed viewer with its own URL, so a report is a
first-class artefact rather than a wall of text in a thread.

```ts
const html = `<!doctype html>
<meta charset="utf-8">
<title>${t.key} — coverage</title>
<style>body{font:14px system-ui;margin:2rem;max-width:50rem}table{border-collapse:collapse}
td,th{border:1px solid #ddd;padding:.3rem .6rem}</style>
<h1>${t.key} — coverage</h1>
<table><tr><th>Module</th><th>Lines</th></tr>${rows}</table>`;

const report = await tm.files.upload(key, { name: 'coverage.html', text: html });
await tm.messages.post(key, {
  markdown: [
    '**Coverage report attached.**',
    '',
    `| Module | Lines |`,
    `| --- | --- |`,
    ...top5.map((r) => `| ${r.module} | ${r.lines}% |`),
  ].join('\n'),
  attachments: [report.id],
});
```

Inline everything — the iframe has no same-origin access and should not expect the network. The same
call with `name: 'plan.md'` publishes a Markdown document instead, which renders with a table of
contents.

### 7.5 React to being assigned (a stateless worker)

The smallest useful orchestrator: no long-running process, no cursor of your own. Run it on a timer,
or from a webhook, and let the inbox be the queue.

```ts
const summary = await tm.work(
  async ({ ticket, beat, tm }) => {
    if (!ticket) return;
    await beat?.update({ message: 'On it' });
    const t = await tm.tickets.get(ticket, { messages: 20 });
    await tm.messages.post(ticket, { markdown: await answer(t) });
  },
  { filter: ['assigned', 'mentioned'], max: 20 },        // handle up to 20, then return
);

console.log(`${summary.handled} handled, ${summary.failed} failed`);
```

`max` makes `work()` return instead of running forever — the right shape for a cron job or a
serverless function. Events it did not reach stay in the inbox for the next run, and a handler that
throws leaves its event unacked, so the work comes back rather than disappearing.
