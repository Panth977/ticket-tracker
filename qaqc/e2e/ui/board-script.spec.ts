/**
 * THE BOARD SCRIPT (docs/plan/board-script.html, ORCH-35): a ticket's fields
 * and the board's filters are the board's code.
 *
 *   1. A new board runs the default script: Details shows Stage and Assignees,
 *      nothing else; the Filter popover has "Only mine".
 *   2. An admin saves a script with its own field (Severity, kept under the
 *      key `severity`), three assignee pickers whose union is assigneeUids, and
 *      a sort. The Details pane draws it; an edit writes what onFieldChange says.
 *   3. "Only mine" in the Filter popover leaves only my tickets on the board.
 *   4. A board from before scripts runs the script generated from its settings:
 *      its Priority picker is still there.
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson, read } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const SCRIPT = `export default class BoardScript {
  filters() { return { mine: false }; }
  filterRender({ filters }) { return [ui.toggle({ id: 'mine', label: 'Only mine', value: filters.mine })]; }
  onFilter({ ticket, filters, me }) { return !filters.mine || ticket.assigneeUids.includes(me.id); }
  onSort({ a, b }) { return a.title.localeCompare(b.title); }
  fieldRender({ ticket }) {
    const f = ticket.fields;
    return [
      ui.select({ id: 'severity', label: 'Severity', value: f.severity ?? null,
        options: ['S1', 'S2', 'S3'].map((s) => ({ value: s, label: s })) }),
      ui.people({ id: 'frontend', label: 'Frontend', value: f.frontend ?? [] }),
      ui.people({ id: 'backend', label: 'Backend', value: f.backend ?? [] }),
      ui.people({ id: 'qaqc', label: 'QA', value: f.qaqc ?? [], disabled: !(f.backend ?? []).length }),
    ];
  }
  onFieldChange({ ticket, id, value }) {
    if (id === 'severity') return { fields: { severity: value } };
    const f = { ...ticket.fields, [id]: value };
    const all = [...(f.frontend ?? []), ...(f.backend ?? []), ...(f.qaqc ?? [])];
    return { fields: { [id]: value }, assigneeUids: [...new Set(all)] };
  }
}`;

const details = (page: Page) => page.getByRole('complementary', { name: 'Details' });

test('the board script draws the fields, writes the patch and owns the filter', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const mine = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Zeta: mine',
    assigneeUids: [ada.uid],
  });
  const other = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Alpha: nobody' });

  // ── 1. the default script ──
  await signIn(page, ada.email, `/t/${mine.key}`);
  const pane = details(page);
  await expect(pane.locator('[data-script-control="assignees"]')).toBeVisible();
  await expect(pane.getByText('Stage', { exact: true })).toBeVisible();
  await expect(pane.getByText('Priority', { exact: true })).toHaveCount(0);
  await expect(pane.getByText('Estimate', { exact: true })).toHaveCount(0);

  // ── 2. a script of the board's own ──
  await call(ada, 'templateSave', {
    boardId: b.id,
    template: { kind: 'script', name: 'Board script', code: SCRIPT },
  });
  await expect(pane.locator('[data-script-control="severity"]')).toBeVisible();
  await expect(pane.locator('[data-script-control="assignees"]')).toHaveCount(0);

  await pane.getByRole('button', { name: 'Severity' }).click();
  await page.getByRole('option', { name: 'S2' }).click();
  await page.keyboard.press('Escape');
  await eventually('severity written', async () => {
    const t = await read(`boards/${b.id}/tickets/${mine.ticketId}`);
    return t?.fields?.severity === 'S2';
  });

  // Backend → Ada: assigneeUids becomes the union of the three pickers.
  await pane.getByRole('button', { name: 'Backend' }).click();
  await page.getByRole('option', { name: /Ada/ }).click();
  await page.keyboard.press('Escape');
  const t = await eventually('backend written', async () => {
    const x = await read(`boards/${b.id}/tickets/${mine.ticketId}`);
    return x?.fields?.backend?.length ? x : null;
  });
  expect(t.fields.backend).toEqual([ada.uid]);
  expect(t.assigneeUids).toEqual([ada.uid]);
  // QA was disabled until someone had the backend.
  await expect(pane.getByRole('button', { name: 'QA' })).toBeEnabled();

  // ── 3. the board: onSort orders, "Only mine" filters ──
  await page.goto(`/b/${b.key}`);
  const cardOf = (key: string) => page.getByRole('button', { name: new RegExp(`^${key} `) });
  await expect(cardOf(mine.key)).toBeVisible();
  await expect(cardOf(other.key)).toBeVisible();
  await page.getByRole('button', { name: 'Filter' }).click();
  const pop = page.getByTestId('script-filters');
  await pop.getByLabel('Only mine').check();
  await expect(cardOf(other.key)).toHaveCount(0);
  await expect(cardOf(mine.key)).toBeVisible();
  await pop.getByRole('button', { name: 'Reset filters' }).click();
  await expect(cardOf(other.key)).toBeVisible();

  // ── settings › Script: the editor previews the saved code ──
  await page.goto(`/b/${b.key}/settings/script`);
  await expect(page.getByTestId('script-kept')).toHaveText('2 of 2 tickets shown');
});

test('a board from before board scripts keeps its fields (generated script)', async ({ page }) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  // As if the board was made before scripts: no saved script.
  await admin().db.doc(`boards/${b.id}/templates/script`).delete();
  const t = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Old ticket' });

  await signIn(page, ada.email, `/t/${t.key}`);
  const pane = details(page);
  await expect(pane.locator('[data-script-control="priority"]')).toBeVisible();
  await expect(pane.locator('[data-script-control="due"]')).toBeVisible();
  await expect(pane.locator('[data-script-control="estimate"]')).toBeVisible();

  await page.goto(`/b/${b.key}/settings/script`);
  await expect(page.getByTestId('script-generated')).toBeVisible();
});
