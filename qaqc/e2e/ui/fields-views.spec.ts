/**
 * Flow: "Adding a custom field and a view over it" (app/flows.json):
 * an admin adds 'Client' (select: Acme, Globex) and 'Contract value'
 * (currency INR) in Board settings; then the kanban is grouped by Client,
 * filtered 'Contract value > 5L', and saved as a shared view that a
 * teammate sees.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  admin,
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

async function addField(
  page: Page,
  name: string,
  type: string,
  extra: (dlg: ReturnType<Page['getByRole']>) => Promise<void>,
) {
  const dlg = page.getByRole('dialog', { name: 'New custom field' });
  // the settings page may still be settling on the board doc: retry the click
  await expect(async () => {
    await page.getByRole('button', { name: 'New field' }).click();
    await expect(dlg).toBeVisible({ timeout: 2000 });
  }).toPass();
  await dlg.getByRole('textbox', { name: /^Name/ }).fill(name);
  await dlg.getByRole('combobox', { name: /^Type/ }).selectOption(type);
  await extra(dlg);
  await dlg.getByRole('button', { name: 'Add field' }).click();
  await expect(dlg).toBeHidden();
}

test('custom fields in settings → group + filter on them → save as a shared view', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');

  await signIn(page, ada.email, `/b/${b.key}/settings/fields`);
  await addField(page, 'Client', 'select', async (dlg) => {
    for (const opt of ['Acme', 'Globex']) {
      await dlg.getByLabel('New Options name').fill(opt);
      await dlg.getByLabel('New Options name').press('Enter');
    }
  });
  await addField(page, 'Contract value', 'currency', async (dlg) => {
    await dlg.getByRole('textbox', { name: 'Currency' }).fill('INR');
  });
  await page.getByRole('button', { name: 'Save section' }).click();

  // boardUpdate appended two FieldDefs (and wrote no ticket)
  const fields = await eventually('fields saved', async () => {
    const f = (await read(`boards/${b.id}`))?.fields as {
      id: string;
      name: string;
      type: string;
      options?: { id: string; name: string }[];
      config?: { currency?: string };
    }[];
    return f?.length === 2 ? f : null;
  });
  const client = fields.find((f) => f.name === 'Client')!;
  const value = fields.find((f) => f.name === 'Contract value')!;
  expect(client.options!.map((o) => o.name)).toEqual(['Acme', 'Globex']);
  expect(value).toMatchObject({ type: 'currency', config: { currency: 'INR' } });

  // three tickets with values (through the command, as the Field panel would)
  const acme = client.options!.find((o) => o.name === 'Acme')!.id;
  const globex = client.options!.find((o) => o.name === 'Globex')!.id;
  const mk = async (title: string, c: string, v: number) => {
    const { key } = await call(ada, 'ticketCreate', {
      boardId: b.id,
      title,
      fields: { [client.id]: c, [value.id]: v },
    });
    return key;
  };
  const big = await mk('Acme renewal', acme, 900_000);
  const small = await mk('Acme add-on', acme, 120_000);
  const other = await mk('Globex pilot', globex, 750_000);

  await page.goto(`/b/${b.key}`);
  // Group: Client
  await page.getByRole('button', { name: /^Group/ }).click();
  await page
    .getByRole('dialog', { name: 'View options' })
    .getByLabel('Columns')
    .selectOption(`fields.${client.id}`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Acme', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Globex', exact: true })).toBeVisible();

  // Filter: Contract value > 500000
  await page.getByRole('button', { name: /^Filter/ }).click();
  const filter = page.getByRole('dialog', { name: 'Filter' });
  await filter.getByRole('button', { name: 'Condition' }).click();
  await filter.getByLabel('Field', { exact: true }).selectOption(`fields.${value.id}`);
  await filter.getByLabel('Condition', { exact: true }).selectOption('gt');
  await filter.getByLabel('Value', { exact: true }).fill('500000');
  await filter.getByLabel('Value', { exact: true }).press('Tab');
  await page.keyboard.press('Escape');

  const acmeCol = page.getByRole('region', { name: 'Acme', exact: true });
  await expect(acmeCol.getByRole('button', { name: new RegExp(`^${big} `) })).toBeVisible();
  await expect(acmeCol.getByRole('button', { name: new RegExp(`^${small} `) })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Globex', exact: true })
      .getByRole('button', { name: new RegExp(`^${other} `) }),
  ).toBeVisible();

  // Save as shared view — §Q2: the open tab is its own menu, there is no 'View ▾' button.
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: 'Board' })
    .click();
  await page.getByRole('menuitem', { name: 'Save as shared view…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Big contracts');
  await dlg.getByRole('button', { name: 'Save view' }).click();
  // it opens straight away, so it is the active tab (a button, not a link)
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Big contracts' }),
  ).toBeVisible();

  // it is stored as a shared view with the group + filter
  const views = await eventually('saved view', async () => {
    const all = (await admin().db.collection(`boards/${b.id}/views`).get()).docs.map((d) =>
      d.data(),
    );
    return all.find((v) => v.name === 'Big contracts');
  });
  expect(views).toMatchObject({ scope: 'shared', groupBy: `fields.${client.id}` });
  expect(JSON.stringify(views.filter)).toContain(`fields.${value.id}`);

  // Grace opens it and sees the same thing
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/b/${b.key}`);
  await gp
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Big contracts' })
    .click();
  await expect(
    gp
      .getByRole('region', { name: 'Acme', exact: true })
      .getByRole('button', { name: new RegExp(`^${big} `) }),
  ).toBeVisible();
  await expect(gp.getByRole('button', { name: new RegExp(`^${small} `) })).toHaveCount(0);
  await ctx.close();
});
