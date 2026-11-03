/**
 * THE BOARD SCRIPT DRAWS THE BOARD (docs/plan/board-script.html, ORCH-35) — in a
 * real browser:
 *
 *   views    a new board has Board and Table only; the script's previews are tabs
 *   table    previewTicketTable's columns; an editable cell writes through onFieldChange
 *   bulk     select rows → the script's bulk control → onBulkChange patches each ticket
 *   cards    previewTicketCard draws the Board's cards
 *   preview  h.calendar from previews(): a chip opens its ticket, a drag moves its date
 *   forms    a message form in the composer, a ticket form in New ticket
 *   sandbox  the code cannot reach the app's storage; an endless loop is stopped
 */
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_BOARD_SCRIPT } from '@tm/shared';
import {
  call,
  eventually,
  messagesOf,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const save = (who: Parameters<typeof call>[0], boardId: string, code: string) =>
  call(who, 'templateSave', {
    boardId,
    template: { kind: 'script', name: 'Board script', code },
  });

/** The default script with extra hooks at the end of its object (a later key wins). */
const withHooks = (hooks: string) => DEFAULT_BOARD_SCRIPT.replace(/\}\);\s*$/, `${hooks}\n});\n`);

async function row(page: Page, key: string) {
  const r = page.locator(`[data-ticket-row="${key}"]`);
  await expect(r).toBeVisible();
  return r;
}

test('Board + Table only; the script draws the table, the bulk bar, the cards and a calendar', async ({
  page,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Drawn' });
  const day = (d: number) => Date.UTC(2026, 10, d, 9, 0);
  const one = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Alpha', dueAt: day(10) });
  const two = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Beta', dueAt: day(12) });

  // A Calendar view saved before board scripts: no tab, and its URL leads to the default view.
  const board0 = await read<Record<string, unknown> & { defaultViewId: string }>(`boards/${b.id}`);
  const def = await read<Record<string, unknown>>(`boards/${b.id}/views/${board0!.defaultViewId}`);
  const old = await call(ada, 'viewSave', {
    boardId: b.id,
    view: {
      ...(def as object),
      ownerUid: undefined,
      name: 'Old calendar',
      type: 'calendar',
      position: 9,
    },
  } as never);

  // ── a new board: Board and Table, and the default script's Calendar preview ──
  await signIn(page, ada.email, `/b/${b.key}/${old.viewId}`);
  await expect(page).toHaveURL(new RegExp(`/b/${b.key}/${board0!.defaultViewId}`));
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs.locator('[data-view-tab]')).toHaveCount(2);
  await expect(tabs.locator('[data-preview-tab="Calendar"]')).toBeVisible();

  // ── table: the script's columns; an editable cell; the bulk bar ──
  await tabs.getByText('Table', { exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Assignees' })).toBeVisible();
  const r1 = await row(page, one.key);
  await expect(r1.locator('[data-col="stage"]')).not.toBeEmpty();
  await r1.locator('[data-col="assignees"]').getByRole('button').click();
  await page.getByRole('option', { name: /Ada/ }).click();
  await page.keyboard.press('Escape');
  await eventually('assigned from the table', async () =>
    (await read<{ assigneeUids: string[] }>(`boards/${b.id}/tickets/${one.ticketId}`))?.assigneeUids
      .length === 1
      ? true
      : null,
  );
  await r1.getByRole('checkbox').click();
  await (await row(page, two.key)).getByRole('checkbox').click();
  const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
  await bar.getByTestId('script-bulk').getByRole('button', { name: 'Add assignees' }).click();
  await page.getByRole('option', { name: /Ada/ }).click();
  await page.keyboard.press('Escape');
  await eventually('both assigned by the bulk bar', async () => {
    const a = await read<{ assigneeUids: string[] }>(`boards/${b.id}/tickets/${one.ticketId}`);
    const c = await read<{ assigneeUids: string[] }>(`boards/${b.id}/tickets/${two.ticketId}`);
    return a?.assigneeUids.includes(ada.uid) && c?.assigneeUids.includes(ada.uid) ? true : null;
  });

  // ── cards and a calendar on due dates, from the script ──
  await save(
    ada,
    b.id,
    withHooks(`
  previewTicketCard({ ticket: t }) {
    return h.text({ mono: true }, 'CARD ' + t.key);
  },
  previews() {
    return {
      Due: ({ tickets, openTicket, updateTicket }) => h.calendar({
        date: ${day(10)},
        items: tickets.filter((t) => t.dueAt).map((t) => ({ id: t.id, title: t.title, start: t.dueAt })),
        onOpen: ({ id }) => openTicket({ id }),
        onMove: ({ id, start }) => updateTicket({ id, patch: { dueAt: start } }),
      }),
    };
  },`),
  );
  await page.goto(`/b/${b.key}`);
  await tabs.getByText('Board', { exact: true }).click();
  await expect(page.locator('.tm-template-card').getByText(`CARD ${one.key}`)).toBeVisible();
  await page.locator('[data-preview-tab="Due"]').click();
  const cal = page.locator('[data-widget="calendar"]');
  await expect(cal.locator(`[data-item="${one.ticketId}"]`)).toHaveText('Alpha');
  // A drag to the 14th moves the due date by four days, same time of day.
  const target = cal.getByRole('gridcell').filter({ hasText: /^14/ }).first();
  await cal.locator(`[data-item="${one.ticketId}"]`).dragTo(target);
  await eventually('moved by the calendar', async () =>
    (await read<{ dueAt: number }>(`boards/${b.id}/tickets/${one.ticketId}`))?.dueAt ===
    Date.UTC(2026, 10, 14, 9, 0)
      ? true
      : null,
  );
  await cal.locator(`[data-item="${two.ticketId}"]`).click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible();
});

test('forms: a message form in the composer, a ticket form in New ticket', async ({ page }) => {
  const ada = await newPerson('Ada', 'Byron');
  const b = await newBoard(ada, { name: 'Forms' });
  await save(
    ada,
    b.id,
    DEFAULT_BOARD_SCRIPT.replace(
      /\n {2}forms\(\) \{[\s\S]*?\n {2}\},\n/,
      `
  forms() {
    return [
      { id: 'bug', kind: 'message', name: 'Bug report' },
      { id: 'feature', kind: 'ticket', name: 'Feature' },
    ];
  },
  formState({ id }) {
    return id === 'bug' ? { steps: '', severity: 'medium' } : { title: '', area: 'Frontend' };
  },
  formRender({ id, state, setState }) {
    if (id === 'bug')
      return h.col(
        h.select({ label: 'Severity', value: state.severity, options: ['low', 'medium', 'high'], onChange: (severity) => setState({ severity }) }),
        h.textarea({ label: 'Steps', name: 'steps', value: state.steps, onInput: (steps) => setState({ steps }) }),
      );
    return h.col(
      h.input({ label: 'Title', name: 'title', value: state.title, onInput: (title) => setState({ title }) }),
      h.select({ label: 'Area', value: state.area, options: ['Frontend', 'Backend'], onChange: (area) => setState({ area }) }),
    );
  },
  formSubmit({ id, state }) {
    if (id === 'bug') {
      if (!state.steps.trim()) return { type: 'invalid', error: { steps: 'Required' } };
      return { type: 'valid', msg: '**Bug** · ' + state.severity + '\\n\\n' + state.steps, data: state };
    }
    return { type: 'valid', ticket: { title: '[' + state.area + '] ' + state.title } };
  },
`,
    ),
  );
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Crash on save',
    stageId: stage(b, 'To do'),
  });

  // ── the composer's 📋 ──
  await signIn(page, ada.email, `/t/${t.key}`);
  const reply = page.getByRole('group', { name: 'Reply' });
  await reply.getByRole('button', { name: 'Use a template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bug report' });
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.getByText('Required')).toBeVisible();
  const steps = dialog.getByRole('textbox', { name: 'Steps' });
  await steps.click();
  const text = 'Press save twice quickly';
  await page.keyboard.type(text, { delay: 5 });
  await expect(steps).toHaveValue(text);
  await dialog.getByRole('combobox', { name: 'Severity' }).selectOption('high');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();
  const msg = await eventually('the message stored', async () =>
    (await messagesOf(b.id, t.ticketId)).find((m) => m.template),
  );
  expect(msg.markdown).toBe(`**Bug** · high\n\n${text}`);
  expect(msg.template).toEqual({
    id: 'script-bug',
    name: 'Bug report',
    data: { steps: text, severity: 'high' },
  });

  // ── New ticket › Feature ──
  await page.goto(`/b/${b.key}`);
  await page.getByRole('button', { name: 'New ticket' }).click();
  const nt = page.getByRole('dialog');
  await nt.getByRole('button', { name: 'Feature' }).click();
  await nt.getByRole('textbox', { name: 'Title' }).fill('Dark mode');
  await nt.getByRole('button', { name: 'Create ticket' }).click();
  await expect(nt).toBeHidden();
  await expect(page.getByText('[Frontend] Dark mode')).toBeVisible();
});

test('the sandbox: no app storage, no endless loops', async ({ page }) => {
  const ada = await newPerson('Ada', 'King');
  const b = await newBoard(ada, { name: 'Sandbox' });
  await save(
    ada,
    b.id,
    withHooks(`
  previews() {
    return {
      Probe: {
        state: async () => {
          let idb = 'open';
          try { indexedDB.open('firebaseLocalStorageDb'); } catch (e) { idb = 'blocked'; }
          const local = typeof localStorage === 'undefined' ? 'none' : 'present';
          let api = 'unreachable';
          try { const r = await fetch('/api/ping'); api = 'reached ' + r.status; } catch (e) { api = 'unreachable'; }
          return { idb, local, api, origin: self.origin };
        },
        render: ({ state: s }) => h.text(['idb:' + s.idb, 'local:' + s.local, 'api:' + s.api, 'origin:' + s.origin].join(' ')),
      },
      Spin: () => h.button({ label: 'Spin', onClick: () => { for (;;) {} } }),
    };
  },`),
  );
  await signIn(page, ada.email, `/b/${b.key}`);
  await page.locator('[data-preview-tab="Probe"]').click();
  const probe = page.locator('[data-preview="Probe"]');
  await expect(probe).toContainText('idb:blocked');
  await expect(probe).toContainText('local:none');
  await expect(probe).toContainText('api:unreachable');
  await expect(probe).toContainText('origin:null');

  await page.locator('[data-preview-tab="Spin"]').click();
  await page.locator('[data-preview="Spin"]').getByRole('button', { name: 'Spin' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'stopped responding' })).toBeVisible({
    timeout: 10_000,
  });
});
