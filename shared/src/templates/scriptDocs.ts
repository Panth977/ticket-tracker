/**
 * THE BOARD SCRIPT REFERENCE (docs/plan/board-script.html) — one Markdown text,
 * served at /integrate (scripts/integration-source/87-board-script.md, marker
 * {{gen:boardscript}}), in /llms-full.txt and by the MCP tool get_template_docs.
 * Keep it in step with the runtime (frontend/src/lib/templates/worker/runtime.js)
 * and the shapes in ./script.ts.
 */
import { SCRIPT_TEMPLATE_ID } from './schema.js';
import { DEFAULT_BOARD_SCRIPT } from './script.js';

export const BOARD_SCRIPT_DOCS_MD = `## Board script

Out of the box a ticket has two fields: **Stage** and **Assignees**. Everything
else a board's tickets show, and every filter above the board, is **code**: the
board's script. A board has exactly one. Its admins edit it in *Board settings ›
Script*, or write it over MCP or the API (\`template_save\` / \`POST /api/templateSave\`,
\`kind: 'script'\`; it is always the template \`${SCRIPT_TEMPLATE_ID}\`).

* **Stage is not in the script.** The app draws Stage above the script's fields, with
  the board's stage grants and stage rules, as before.
* The script **draws** the Details pane's fields (\`fieldRender\`) and **decides what an edit
  writes** (\`onFieldChange\`): one change may write several things.
* It **owns the board's filters** (\`filterRender\`, \`onFilter\`) and, if it wants,
  **the order** (\`onSort\`). A saved view keeps its sort, grouping and columns; the
  script's filter applies to every view, and \`onSort\` (when present) replaces the view's sort.
* **Every hook, every \`ui.*\` control and every \`this.api.*\` call takes ONE object of
  named arguments.**

### Where it runs, and what it is not

It runs in each person's **browser**, in the same sandbox as templates (an opaque-origin
Worker; see *Templates › How it runs*), **as the person looking**. So:

* \`onFilter\` hides tickets **in the list**. It is not access control: anyone on the board
  can still open a ticket by its key, find it in search, or read it over the API.
* **Agents, the REST API and MCP do not run the script.** They write tickets directly
  (\`ticket_update\` with \`fields\`, \`assignees\` …), and the server checks those writes
  the way it always does. Rules you put in \`onFieldChange\` or \`disabled\` hold in the app only.
* A new board starts with the default below, saved. A board that existed before board
  scripts (or whose script was deleted) runs a script **generated from its old settings** (its
  priority, start, due, estimate, tags and custom fields, with their option lists written into
  the code), until an admin saves one. There are no Priorities, Tags or Custom fields settings
  pages: option lists live in the script. \`priorityId\` / \`tagIds\` only take the values a
  board already had; a new list of values belongs in the ticket's own \`fields\`.

### The shape

\`\`\`js
export default class BoardScript {
  filters()                                             // → the filter values a person starts with
  filterRender({ filters, me, board })                  // → ui.* controls in the Filter popover
  onFilter({ ticket, filters, me, board })              // → true = show (runs with no filter set too)
  onSort({ a, b, filters, me, board })                  // → number, like Array.sort (optional, sync)
  fieldRender({ ticket, me, board })                    // → ui.* controls under Stage
  onFieldChange({ ticket, id, value, allDay, me, board }) // → a ticket patch, or nothing
}
\`\`\`

Only \`fieldRender\` is required. \`export default { fieldRender(…) { … } }\` (a plain object) works too.
Hooks may be \`async\` (all but \`onSort\`). \`this.api\` is the template \`api\`
(below). \`console.log\` shows in the editor's console.

* **\`ticket\`** — \`{ id, key, title, description, stageId, stage: { id, name, category },
  assigneeUids, assignees: [{ id, name, email, role }], priorityId, priority, tagIds, tags,
  startAt, dueAt, dueAllDay, estimate, commitments: { uid: millis }, fields, fieldsByName,
  reporter, state, counts, tasks, createdAt, updatedAt }\`. \`fields\` is as stored: the
  board's settings-defined fields by id (\`f_xxxxxx\`) and **the script's own values by any key
  you choose** (a letter, then up to 39 letters, digits or \`_\`; not \`f_…\`).
* **\`me\`** — \`{ id, name, email, role }\` (role on this board: admin, editor, commenter, viewer).
* **\`board\`** — \`{ id, key, name, stages, priorities, tags, fields }\` (options with id, name, color).
* **\`filters\`** — the person's filter values: what \`filters()\` returned, changed by the
  filter controls (each control's \`id\` is its key). Kept per person, board and browser.

### Controls: \`ui.*\`

Each takes one object; \`id\` is required (except \`note\`), unique in one list.

| control | value | extra |
| --- | --- | --- |
| \`ui.text\` | string | \`placeholder\` |
| \`ui.longText\` | string | \`placeholder\` |
| \`ui.number\` | number or null | \`min\`, \`max\`, \`step\` |
| \`ui.toggle\` | boolean | |
| \`ui.select\` | option value or null | \`options: [{ value, label, color? }]\`, \`clearable\` |
| \`ui.multiSelect\` | option values | \`options\` |
| \`ui.people\` | uids (one uid with \`multiple: false\`) | \`people: [uid…]\` to offer (default: the board's members), \`commitments: true\` |
| \`ui.date\` | millis or null | \`withTime\`, \`allDay\` (onFieldChange gets \`allDay\` too) |
| \`ui.dateRange\` | \`{ start, end }\` or null | |
| \`ui.note\` | — | \`text\` (Markdown), \`tone\` |

Every control also takes \`label\`, \`disabled\`, \`hidden\`, \`required\` (a star), \`help\`.
Text and numbers report a change **on blur or Enter**, never per key. A person without edit
rights on the board sees every control disabled whatever the script says.
\`ui.people({ …, commitments: true })\` shows each person's commitment date; changing one
writes \`ticket.commitments\` directly.

### What \`onFieldChange\` returns

A patch, checked in the app and then written as the person (\`ticketUpdate\`):
\`{ title?, assigneeUids?, priorityId?, tagIds?, startAt?, dueAt?, dueAllDay?, estimate?,
commitments?, fields? }\`. \`fields\` merges per key (\`{ fields: { severity: 'S1' } }\` leaves
the others); \`null\` clears one. Return nothing to write nothing; \`throw new Error('…')\`
shows the message to the person. Removing someone from \`assigneeUids\` also clears their
commitment. Keep \`assigneeUids\` meaningful: notifications, *My work*, agents and
\`list_my_tickets\` all use it.

### \`this.api\`

As in templates, read-only and as the viewer, with named arguments:
\`this.api.me()\`, \`this.api.board()\`, \`this.api.members()\`,
\`this.api.tickets.get({ key })\`, \`this.api.tickets.list({ stage?, assignee?, tag?, priority?, text?, limit? })\`,
\`this.api.tickets.search({ text, limit? })\`, \`this.api.storage.get({ key })\`,
\`this.api.storage.set({ key, value })\`, and for **another board** the viewer can read:
\`this.api.boards.tickets({ board: 'OPS', text?, limit? })\` (its active tickets, with
\`stageId\`, \`assigneeUids\`, \`fields\` …).

### The default

\`\`\`js
${DEFAULT_BOARD_SCRIPT.trim()}
\`\`\`

### Example: three assignee fields

\`\`\`js
export default class BoardScript {
  fieldRender({ ticket }) {
    const f = ticket.fields;
    return [
      ui.people({ id: 'frontend', label: 'Frontend', value: f.frontend ?? [] }),
      ui.people({ id: 'backend', label: 'Backend', value: f.backend ?? [] }),
      // QA can be set once someone has the backend.
      ui.people({ id: 'qaqc', label: 'QA', value: f.qaqc ?? [], disabled: !(f.backend ?? []).length }),
    ];
  }
  onFieldChange({ ticket, id, value }) {
    const f = { ...ticket.fields, [id]: value };
    const all = [...(f.frontend ?? []), ...(f.backend ?? []), ...(f.qaqc ?? [])];
    // assigneeUids stays the union: notifications, My work and agents use it.
    return { fields: { [id]: value }, assigneeUids: [...new Set(all)] };
  }
}
\`\`\`

### Example: a field from another board, and a sort

\`\`\`js
export default class BoardScript {
  async fieldRender({ ticket }) {
    const releases = await this.api.boards.tickets({ board: 'REL', limit: 50 });
    return [
      ui.people({ id: 'assignees', label: 'Assignees', value: ticket.assigneeUids }),
      ui.select({
        id: 'release', label: 'Release', value: ticket.fields.release ?? null,
        options: releases.map((r) => ({ value: r.key, label: \`\${r.key} · \${r.title}\` })),
      }),
    ];
  }
  onFieldChange({ id, value }) {
    if (id === 'assignees') return { assigneeUids: value };
    return { fields: { [id]: value } };
  }
  // Due first, nearest at the top; no due date last.
  onSort({ a, b }) {
    return (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  }
}
\`\`\`
`;
