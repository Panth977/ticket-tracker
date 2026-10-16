/**
 * THE TEMPLATE REFERENCE — one Markdown text, written once, served three ways:
 * the MCP tool get_template_docs, the Templates chapter of /llms-full.txt and
 * /integrate (scripts/gen-integration.mjs, marker {{gen:templates}}), and the
 * Claude plugin's `template` skill. Keep it in step with the runtime
 * (frontend/src/lib/templates/worker/runtime.js) and the renderer (render.ts);
 * the frontend tests pin both.
 */
import { TEMPLATE_CODE_MAX, TEMPLATE_DATA_MAX, TEMPLATES_MAX } from './schema.js';

export const TEMPLATE_DOCS_MD = `## Templates

A **template** is a few lines of JavaScript a board's admins write — or ask an
agent to write — that shape the board's own UI in three places:

| kind | where it shows | what its code does |
| --- | --- | --- |
| \`message\` | the composer's 📋 *Use a template* | draws a form; \`submit\` returns the message (Markdown) and its data |
| \`ticket\` | *New ticket* › a template | draws a form; \`submit\` returns the ticket to create |
| \`card\` | a kanban view whose *Layout › Card* names it | draws each card from \`ctx.ticket\` |

Templates live on the board (\`boards/{b}/templates/{id}\`), at most ${TEMPLATES_MAX} per board,
${TEMPLATE_CODE_MAX.toLocaleString('en-US')} characters of code each. Admins (people or agents) create and
change them — Settings › Templates in the app, \`template_save\` / \`template_delete\` over MCP,
\`POST /api/templateSave\` — and everyone on the board uses them. Copying a board copies its templates.

### How it runs

The code never runs in the app's page. Each person's browser starts it in a **Web Worker
with an opaque origin** (a \`data:\` URL): no cookies, no IndexedDB or localStorage, no
same-origin requests, no access to the page. Your code computes; the app draws.

* \`render\` returns a **tree** built with \`h\`. The app draws it on the main thread and,
  on every re-render, **patches** the page instead of rebuilding it: an element keeps its
  DOM node while its type and position (or its \`key\`) stay the same, so the input you are
  typing in keeps its focus and caret while the form changes around it.
* \`false\`, \`null\` and \`''\` in a child list are **holes** that keep their slot —
  \`cond && h.select(…)\` appearing never moves the fields after it.
* A **controlled** input (\`value\` given) is only overwritten when the worker has seen your
  last keystroke from it, so typing fast never loses characters.
* The worker is pinged every second; three seconds without an answer (an endless loop)
  and it is stopped, with an error in the form.
* \`fetch()\` to the open web works (CORS applies). The app's own API is reachable only
  through \`api\` below.

### The module

\`\`\`js
export default {
  // optional — the first state; may be async; gets ctx
  state: (ctx) => ({ kind: 'bug', steps: '' }),

  // required — draw the state. Called again after every setState.
  render(state, setState, h, ctx) {
    return h.col(/* … */);
  },

  // message and ticket templates — what the form sends (see "submit")
  submit(state, ctx) {
    return { type: 'valid', msg: 'Hello' };
  },
};
\`\`\`

* Exactly one \`export default\`. No \`import\` — the builder \`h\`, \`api\` and \`console\`
  are given to you. \`export default function render(…)\` is a card template with only render.
* \`setState(patch)\` merges an object into the state (or takes \`(state) => patch\`) and
  re-renders on the next microtask; several calls render once.
* Handlers (\`onInput\`, \`onChange\`, \`onClick\` …) may be \`async\`; call \`setState\` when done.
* \`console.log/warn/error\` print to the editor's Console.
* An error (compile, \`state\`, \`render\`, a handler, \`submit\`) shows in the form with its
  **line number**; in the editor the line is a button that jumps to it.

### ctx

| field | what |
| --- | --- |
| \`ctx.kind\` | \`'message' \\| 'ticket' \\| 'card'\` |
| \`ctx.board\` | \`{ id, key, name, description, stages[], priorities[], tags[], fields[] }\` — options are \`{ id, name, color }\`, stages add \`category\`, fields are \`{ id, name, type, required, options[] }\` |
| \`ctx.me\` | the person (or agent) looking: \`{ id, name, email, role }\` |
| \`ctx.ticket\` | message templates: the ticket whose thread it is; card templates: the card's ticket (below) |
| \`ctx.api\` | the same \`api\` as the global |

A **ticket** (\`ctx.ticket\`, \`api.tickets.*\`) is
\`{ id, key, title, description, stage, priority, tags[], assignees[], reporter, state, dueAt,
dueAllDay, startAt, estimate, fields, fieldValues, counts: { messages, files }, tasks,
createdAt, updatedAt, completedAt }\` — \`description\` is plain text, \`stage\` / \`priority\` /
\`tags\` are \`{ id, name, color }\`, \`assignees\` are members \`{ id, kind, name, email, role }\`,
dates are milliseconds, \`fields\` is **by field name** with readable values (option names,
member names) and \`fieldValues\` **by field id** as stored, \`tasks\` is \`{ done, total }\` or null.

### api

Every call is answered by the app **as the person looking, for this board only** — a
template sees what that person could see on this board anyway, and nothing else. All
calls return promises.

| call | answers |
| --- | --- |
| \`api.board()\` | the board, as \`ctx.board\` |
| \`api.me()\` | as \`ctx.me\` |
| \`api.members()\` | everyone on the board: \`{ id, kind: 'user' \\| 'agent', name, email, role }[]\` |
| \`api.tickets.get(key)\` | one ticket of this board by key (\`'ENG-42'\`), or null |
| \`api.tickets.list({ stage?, assignee?, tag?, priority?, text?, limit? })\` | active tickets, newest change first; filters take ids or names, \`assignee\` also an email or \`'me'\`; \`limit\` ≤ 200 (default 50) |
| \`api.tickets.search(text, { limit? })\` | best matches by key and title |
| \`api.storage.get(key)\` / \`api.storage.set(key, value)\` | this person's own small store for this template (JSON, ≤ 10 000 characters a key; \`null\` deletes) — e.g. remember the last choice |

A template never writes through \`api\`. The only thing it sends is its \`submit\`
answer, and only when the person presses **Send** / **Create ticket**.

### The builder h

Containers take \`(props?, ...children)\`; children are nodes, strings, numbers, arrays,
or holes. Every node takes \`key\` (keeps it across re-renders — use it in \`.map\`),
\`style\` (an object of CSS; \`url()\` is refused) and \`title\` (a tooltip).

| node | props |
| --- | --- |
| \`h.col(…)\` \`h.row(…)\` \`h.grid(…)\` \`h.div(…)\` | \`gap\` (×0.25rem), \`align\` (start · center · end · stretch · baseline), \`justify\` (start · center · end · between · around), \`wrap\` (row), \`cols\` (grid, 1–12), \`padding\`, \`border\`, \`bg\` (surface · muted · accent · success · warning · danger), \`tone\`, \`size\` |
| \`h.text(str, props?)\` | \`tone\` (default · muted · subtle · accent · success · warning · danger), \`size\` (xs · sm · md · lg · xl), \`weight\` (normal · medium · semibold · bold), \`mono\`, \`italic\`, \`strike\`, \`truncate\`, \`block\`, \`color\` (#hex); or \`h.text(props, ...children)\` |
| \`h.heading(str, { level })\` | level 1–4 |
| \`h.markdown(md)\` | GitHub Markdown, sanitised (\`#KEY\` links to the ticket) |
| \`h.badge(str, { tone, color })\` | a pill |
| \`h.divider()\` | a rule |
| \`h.link(label, { href })\` | http(s), mailto or an app path; outside links open a new tab |
| \`h.image({ src, alt, width, height, radius })\` | https or inline png/jpeg/gif/webp |
| \`h.person(id, { size, showName })\` | a member's picture and name |
| \`h.ticket(key, { label })\` | a ticket chip that opens it |
| \`h.progress({ value, max, color })\` | a bar |
| \`h.input({ label, name, value, type, placeholder, hint, error, required, disabled, min, max, step, onInput, onChange, onEnter })\` | \`type\`: text · number · email · url · tel · date · datetime-local · time · password · search · color; handlers get \`(value, { name })\` — a number input's value is a number or null |
| \`h.textarea({ label, name, value, rows, placeholder, hint, error, onInput, onChange })\` | |
| \`h.select({ label, name, value, options, placeholder, multiple, onChange })\` | \`options\`: strings or \`{ value, label, disabled }\`; \`placeholder\` adds an empty first option; \`multiple\` gives and takes an array |
| \`h.radio({ label, name, value, options, onChange })\` | a radio group |
| \`h.checkbox({ label, name, checked, hint, onChange })\` | \`onChange(checked)\` |
| \`h.button(label, { variant, size, disabled, onClick })\` | variant: primary · secondary · ghost · danger; size: sm · md |
| \`h.el(tag, props?, ...children)\` | plain elements: div span p b strong i em u s small code pre kbd mark blockquote ul ol li dl dt dd h1–h6 hr br table thead tbody tr th td caption label section header footer figure figcaption sup sub details summary |

A field's \`name\` ties it to \`submit\`'s errors: \`{ type: 'invalid', error: { steps: 'Required' } }\`
shows *Required* under the input named \`steps\`.

### submit

\`submit(state, ctx)\` may be async. It answers one of:

\`\`\`js
{ type: 'invalid', errMsg: 'Fill in the steps', error: { steps: 'Required' } } // the form stays open
{ type: 'valid', msg: '**Bug** · high', data: { severity: 'high' } }          // message templates
{ type: 'valid', ticket: { title: 'Dark mode', stage: 'To do', tags: ['ui'] } } // ticket templates
\`\`\`

**Message templates**: \`msg\` is Markdown (mention people as \`@email\`, tickets as \`#KEY\`).
\`data\` (any JSON, ≤ ${TEMPLATE_DATA_MAX.toLocaleString('en-US')} characters) is stored on the message as
\`template: { id, name, data }\` — REST and MCP return it, so an agent reads the form's answer
instead of parsing the text.

**Ticket templates**: \`ticket\` is
\`{ title, description?, stage?, priority?, tags?, assignees?, dueAt?, dueAllDay?, startAt?, estimate?, fields? }\`.
Name things the way people do — a stage, priority or tag by id **or name**, people by id,
**email** or name, \`fields\` by field id or **name** (select options by id or name), dates as
milliseconds, \`'2026-10-20'\`, \`'fri'\`, \`'+3d'\` or an ISO date-time. A tag name the board lacks
becomes a new tag; anything else that names nothing is shown as a problem and nothing is
created. The board's required fields must be set. Without \`stage\` the ticket goes where the
dialog was opened (the column's +), else the first stage.

### Card templates

A card template has only \`render\` (and optionally \`state(ctx)\`, run per card). It is drawn
**static**: no handlers, inputs disabled — the card itself opens the ticket. One worker draws
every card of a view in batches, and a card is drawn again only when its ticket changes.
While it loads, or if it throws for one ticket, that card falls back to the built-in card
(with a ⚠ saying why). Choose it per kanban view: *Layout › Card* in the view bar, or
*Cards* when creating a view (\`view_save\` with \`cardTemplateId\`).

### Examples

**A field that decides the next fields** (the reason templates are code):

\`\`\`js
const AREAS = { Frontend: ['Web', 'Phone'], Backend: ['API', 'Jobs', 'Database'] };
export default {
  state: () => ({ area: '', part: '', what: '' }),
  render(s, set, h) {
    return h.col(
      h.select({ label: 'Area', value: s.area, placeholder: 'Pick one', options: Object.keys(AREAS),
        onChange: (area) => set({ area, part: '' }) }),
      s.area && h.select({ label: 'Part', name: 'part', value: s.part, placeholder: 'Pick one',
        options: AREAS[s.area], onChange: (part) => set({ part }) }),
      h.textarea({ label: 'What happened', name: 'what', value: s.what, onInput: (what) => set({ what }) }),
    );
  },
  submit(s) {
    if (!s.part) return { type: 'invalid', error: { part: 'Pick the part' } };
    return { type: 'valid', msg: \`**\${s.area} › \${s.part}**\\n\\n\${s.what}\`, data: s };
  },
};
\`\`\`

**A ticket template that assigns from the board's people:**

\`\`\`js
export default {
  async state() {
    const people = (await api.members()).filter((m) => m.kind === 'user');
    return { people, title: '', owner: (await api.storage.get('owner')) ?? '' };
  },
  render(s, set, h) {
    return h.col(
      h.input({ label: 'Title', name: 'title', value: s.title, onInput: (title) => set({ title }) }),
      h.select({ label: 'Owner', value: s.owner, placeholder: 'Nobody',
        options: s.people.map((p) => ({ value: p.email, label: p.name })),
        onChange: (owner) => { set({ owner }); api.storage.set('owner', owner); } }),
    );
  },
  submit(s) {
    if (!s.title.trim()) return { type: 'invalid', error: { title: 'Required' } };
    return { type: 'valid', ticket: { title: s.title, assignees: s.owner ? [s.owner] : [], tags: ['triage'] } };
  },
};
\`\`\`

**A card that shows what matters on this board:**

\`\`\`js
export default {
  render(state, setState, h, { ticket: t }) {
    return h.col({ gap: 1.5 },
      h.row(h.text(t.key, { mono: true, size: 'xs', tone: 'subtle' }),
        t.priority && h.badge(t.priority.name, { color: t.priority.color })),
      h.text(t.title, { weight: 'medium' }),
      t.tasks && h.progress({ value: t.tasks.done, max: t.tasks.total }),
      t.fields.Customer && h.text('for ' + t.fields.Customer, { size: 'xs', tone: 'muted' }),
      h.row(...t.assignees.map((a) => h.person(a.id, { key: a.id, showName: false }))),
    );
  },
};
\`\`\`

### Over MCP

\`get_template_docs\` (this text, plus a starter per kind), \`list_templates\` (with
\`include_code\` for the code), \`template_save\` (\`{ board, templateId?, template: { kind, name,
code, description?, indicator?, position? } }\` — a template keeps its kind) and
\`template_delete\`. A kanban view takes a card template with \`view_save\`'s
\`view.cardTemplateId\`. Messages read with \`get_messages\` carry \`template\` when a message
template wrote them.
`;
