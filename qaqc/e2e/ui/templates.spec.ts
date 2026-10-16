/**
 * TEMPLATES END TO END (docs/plan/templates.html) — the board's own code, in
 * a real browser:
 *
 *   editor   Settings › Templates › New message template: the starter runs in
 *            the live preview; "Try submit" shows what it would post
 *   composer 📋 → the form; a field that appears never steals the caret;
 *            typing fast loses nothing; Send posts the Markdown + data
 *   ticket   New ticket › a ticket template → a ticket named its way
 *   card     a kanban view with a card template draws its cards with it
 *   sandbox  the code cannot reach the app's storage; an endless loop is stopped
 */
import { expect, test } from '@playwright/test';
import { TEMPLATE_STARTERS } from '@tm/shared';
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

test('message templates: write one in settings, use it from the composer', async ({ page }) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Forms' });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Crash on save',
    stageId: stage(b, 'To do'),
  });

  // ── 1. the editor ──
  await signIn(page, ada.email, `/b/${b.key}/settings/templates`);
  await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
  await page.getByTestId('templates-message').getByRole('button', { name: 'New' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Bug report');
  // The code box shows the starter (CodeMirror loads after the draft is filled in).
  await expect(page.getByTestId('template-code')).toContainText('export default');
  const preview = page.getByTestId('template-preview');
  await expect(preview.getByRole('combobox', { name: 'Type' })).toBeVisible();
  await preview.getByRole('button', { name: 'Try submit' }).click();
  await expect(page.getByTestId('template-tried')).toContainText('Refused');
  await expect(preview.getByText('Required')).toBeVisible();
  await preview.getByRole('textbox', { name: 'Steps to reproduce' }).fill('Click save twice');
  await preview.getByRole('button', { name: 'Try submit' }).click();
  await expect(page.getByTestId('template-tried')).toContainText('Would post:');
  await expect(page.getByTestId('template-tried')).toContainText('severity medium');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const tplId = await eventually('the template saved', async () => {
    const url = new URL(page.url());
    return url.searchParams.get('t');
  });
  const stored = await read<{ kind: string; name: string }>(`boards/${b.id}/templates/${tplId}`);
  expect(stored).toMatchObject({ kind: 'message', name: 'Bug report' });

  // ── 2. the composer ──
  await page.goto(`/t/${t.key}`);
  const reply = page.getByRole('group', { name: 'Reply' });
  await reply.getByRole('button', { name: 'Use a template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bug report' });
  await expect(dialog).toBeVisible();
  const steps = dialog.getByRole('textbox', { name: 'Steps to reproduce' });
  await steps.click();
  // Fast typing: every key reaches the worker and comes back; nothing is undone.
  const text = 'Open the ticket, press save twice quickly, see the crash';
  await page.keyboard.type(text, { delay: 5 });
  await expect(steps).toHaveValue(text);
  await expect(steps).toBeFocused();
  // A field that disappears (severity) keeps the textarea's node — and its focus.
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption('question');
  await expect(dialog.getByRole('combobox', { name: 'Severity' })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Your question' })).toHaveValue(text);
  await dialog.getByRole('combobox', { name: 'Type' }).selectOption('bug');
  await dialog.getByRole('combobox', { name: 'Severity' }).selectOption('high');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();

  const thread = page.getByRole('region', { name: 'Thread' });
  await expect(thread.getByText('severity high')).toBeVisible();
  const msg = await eventually('the message stored', async () =>
    (await messagesOf(b.id, t.ticketId)).find((m) => m.template),
  );
  expect(msg.markdown).toBe(`**Bug** · severity high\n\n${text}`);
  expect(msg.template).toEqual({
    id: tplId,
    name: 'Bug report',
    data: { kind: 'bug', steps: text, severity: 'high' },
  });
});

test('ticket and card templates: create a ticket through a form, draw cards with code', async ({
  page,
}) => {
  const ada = await newPerson('Ada', 'Byron');
  const b = await newBoard(ada, { name: 'Shapes' });
  await call(ada, 'templateSave', {
    boardId: b.id,
    template: { kind: 'ticket', name: 'Feature', code: TEMPLATE_STARTERS.ticket },
  });
  const card = await call(ada, 'templateSave', {
    boardId: b.id,
    template: {
      kind: 'card',
      name: 'Marked',
      code: `export default {
        render(state, setState, h, ctx) {
          const t = ctx.ticket;
          return h.col(h.text('CARD ' + t.key, { mono: true }), h.text(t.title), h.badge(t.stage.name));
        },
      };`,
    },
  });

  // ── New ticket › Feature ──
  await signIn(page, ada.email, `/b/${b.key}`);
  await page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Feature' }).click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Dark mode');
  await dialog.getByRole('combobox', { name: 'Area' }).selectOption('Frontend');
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('[Frontend] Dark mode')).toBeVisible();

  // ── a view drawn by the card template ──
  const board = await read<{ defaultViewId: string }>(`boards/${b.id}`);
  const def = await read<Record<string, unknown>>(`boards/${b.id}/views/${board!.defaultViewId}`);
  const { viewId } = await call(ada, 'viewSave', {
    boardId: b.id,
    view: {
      ...(def as object),
      ownerUid: undefined,
      name: 'Marked cards',
      position: 99,
      cardTemplateId: card.templateId,
    },
  } as never);
  await page.goto(`/b/${b.key}/${viewId}`);
  await expect(page.locator('.tm-template-card').getByText(/^CARD [A-Z0-9]+-1$/)).toBeVisible();
  await expect(page.locator('.tm-template-card').getByText('[Frontend] Dark mode')).toBeVisible();
});

test('the sandbox: no app storage, no endless loops', async ({ page }) => {
  const ada = await newPerson('Ada', 'King');
  const b = await newBoard(ada, { name: 'Sandbox' });
  const probe = await call(ada, 'templateSave', {
    boardId: b.id,
    template: {
      kind: 'message',
      name: 'Probe',
      code: `export default {
        async state() {
          let idb = 'open';
          try { indexedDB.open('firebaseLocalStorageDb'); } catch (e) { idb = 'blocked'; }
          let local = typeof localStorage === 'undefined' ? 'none' : 'present';
          let api = 'unreachable';
          try { const r = await fetch(${JSON.stringify('/api/ping')}); api = 'reached ' + r.status; } catch (e) { api = 'unreachable'; }
          return { idb, local, api, origin: self.origin };
        },
        render: (s, set, h) => h.text(['idb:' + s.idb, 'local:' + s.local, 'api:' + s.api, 'origin:' + s.origin].join(' ')),
        submit: () => ({ type: 'valid', msg: 'x' }),
      };`,
    },
  });
  await call(ada, 'templateSave', {
    boardId: b.id,
    template: {
      kind: 'message',
      name: 'Spin',
      code: `export default {
        render: (s, set, h) => h.button({ label: 'Spin', onClick: () => { for (;;) {} } }),
        submit: () => ({ type: 'valid', msg: 'x' }),
      };`,
    },
  });

  await signIn(page, ada.email, `/b/${b.key}/settings/templates?t=${probe.templateId}`);
  const preview = page.getByTestId('template-preview');
  await expect(page.getByTestId('template-code')).toContainText('firebaseLocalStorageDb');
  await expect(preview).toContainText('idb:blocked');
  await expect(preview).toContainText('local:none');
  await expect(preview).toContainText('api:unreachable');
  await expect(preview).toContainText('origin:null');

  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('button', { name: 'Spin' }).click();
  await page.getByTestId('template-preview').getByRole('button', { name: 'Spin' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'stopped responding' })).toBeVisible({
    timeout: 10_000,
  });
});
