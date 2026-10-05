/**
 * The phase-2 loop end to end (docs/plan/agents.html §B–§I, §J p2-integration):
 *
 *   UI   Ada creates the agent 'Builder' → adds it to her board → makes a
 *        Worker token that acts as it (Account › Tokens, opened from the
 *        agent's page) and copies the token string
 *   MCP  a real MCP client with that token: whoami (the system prompt),
 *        list_my_tickets (the ticket Ada assigned), upload_file report.md +
 *        report.html, post_message attaching both, move_ticket → Review
 *   UI   the ticket shows Builder's message (Agent badge, 'via token …'),
 *        Markdown rendered, a card for each file; the HTML opens in the
 *        sandboxed viewer and at /f/{board}/{ticket}/{file}; the Markdown
 *        document renders with a Source toggle
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  API_URL,
  call,
  eventually,
  newBoard,
  newPerson,
  read,
  stage,
  giveAttachMemory,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const REPORT_MD = [
  '# Release notes 2.0',
  '',
  'Everything that shipped since **1.9**.',
  '',
  '## Highlights',
  '',
  '| Area | Change |',
  '| --- | --- |',
  '| Agents | Tokens act as an agent |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');

// The document's own script runs inside the sandbox (allow-scripts) and fills #out.
const REPORT_HTML = `<!doctype html><html><body>
<h1>Build report</h1><p id="out">static</p>
<script>document.getElementById('out').textContent = 'script ran: ' + (1 + 1);</script>
</body></html>`;

/** The JSON a tool answered with (tools answer one text block of JSON). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool payloads are shaped per tool; each call asserts what it needs
function payload(r: unknown): any {
  const res = r as CallToolResult;
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
  return JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
}

test('agent loop: agent → board → token (UI) → MCP whoami, list, upload, post, move → the UI previews both files', async ({
  page,
  context,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Agent loop' });
  await giveAttachMemory(ada, b.id);

  // ── 1. create the agent in the UI ──────────────────────────────────────────
  await signIn(page, ada.email, '/agents');
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New agent' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByLabel('Name').fill('Builder');
  await dialog.getByLabel('Description').fill('Implements tickets and reports back');
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await page.waitForURL(/\/agents\/ag_[A-Za-z0-9]{16}$/);
  const agentId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: 'Builder', level: 1 })).toBeVisible();

  // ── 2. add it to the board (People & roles is the other door; same command) ─
  const addForm = page.getByRole('form', { name: 'Add Builder to a board' });
  await addForm.getByLabel('Board').selectOption(b.id);
  await addForm.getByLabel('Role').selectOption('editor');
  await addForm.getByRole('button', { name: 'Add to board' }).click();
  await eventually(
    'agent member row',
    async () => (await read(`boards/${b.id}/members/${agentId}`))?.kind === 'agent',
  );
  await expect(page.getByLabel('Role of Builder on Agent loop')).toHaveValue('editor');

  // ── 3. THE agent's token, from its own page (§AA: one token, no board, no checkboxes) ──
  await page.getByRole('button', { name: 'Generate token' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your token now' });
  const token = (await shown.locator('pre').first().textContent())!.trim();
  expect(token).toMatch(/^tm_live_/);
  await shown.getByRole('button', { name: 'I’ve copied it' }).click();

  // Ada assigns a ticket to Builder (the orchestrator will find it).
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Write the release notes',
    stageId: stage(b, 'To do'),
    assigneeUids: [agentId],
  });

  // ── 4. the orchestrator: a real MCP client with nothing but the token ──────
  const mcp = new Client({ name: 'e2e-orchestrator', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  expect(tools).toEqual(
    expect.arrayContaining([
      'whoami',
      'list_my_tickets',
      'upload_file',
      'post_message',
      'move_ticket',
    ]),
  );
  // §AA: the ROLE is the permission — an editor agent creates tickets (there is no Worker preset to hide it).
  expect(tools).toContain('create_ticket');

  const me = payload(await mcp.callTool({ name: 'whoami', arguments: {} }));
  const agentDoc = await read(`agents/${agentId}`);
  expect(me.principal).toMatchObject({ kind: 'agent', id: agentId, name: 'Builder' });
  expect(me.principal.system_prompt).toBe(agentDoc!.systemPrompt);
  expect(me.principal.system_prompt).toContain('You are Builder');

  const mine = payload(await mcp.callTool({ name: 'list_my_tickets', arguments: {} }));
  expect(mine.tickets.map((x: { key: string }) => x.key)).toEqual([t.key]);

  const md = payload(
    await mcp.callTool({
      name: 'upload_file',
      arguments: { key: t.key, name: 'report.md', text: REPORT_MD },
    }),
  );
  const html = payload(
    await mcp.callTool({
      name: 'upload_file',
      arguments: { key: t.key, name: 'report.html', text: REPORT_HTML },
    }),
  );
  expect(md).toMatchObject({ kind: 'markdown' });
  expect(html).toMatchObject({ kind: 'html' });

  payload(
    await mcp.callTool({
      name: 'post_message',
      arguments: {
        key: t.key,
        markdown:
          '## Done\n\nRelease notes are attached:\n\n- [x] `report.md`\n- [x] `report.html`',
        attachments: [md.fileId, html.fileId],
      },
    }),
  );
  const moved = payload(
    await mcp.callTool({ name: 'move_ticket', arguments: { key: t.key, stage: 'Review' } }),
  );
  expect(moved.stage.name).toBe('Review');
  await mcp.close();

  const ticket = await read(`boards/${b.id}/tickets/${t.ticketId}`);
  expect(ticket!.stageId).toBe(stage(b, 'Review'));

  // ── 5. the UI: an agent-authored message with two previews ─────────────────
  await page.goto(`/t/${t.key}`);
  const thread = page.getByRole('region', { name: 'Thread' });
  const msg = thread.getByRole('article', { name: 'Message from Builder' });
  await expect(msg).toBeVisible();
  await expect(msg.locator('[data-agent-badge]').first()).toBeVisible();
  await expect(msg).toContainText('via token Builder');
  // Markdown rendered: a heading and a task list, not the raw '##'.
  await expect(msg.getByRole('heading', { name: 'Done' })).toBeVisible();
  await expect(msg.getByRole('checkbox')).toHaveCount(2);
  await expect(msg).not.toContainText('## Done');

  await expect(msg.locator('[data-kind="markdown"]')).toContainText('Release notes 2.0');
  await expect(msg.locator('[data-kind="html"]')).toBeVisible();
  await expect(msg.getByTitle('Preview of report.html')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('Review');

  // The HTML report in the overlay viewer: sandboxed srcdoc, its own script ran.
  await msg.getByRole('button', { name: 'Open report.html' }).click();
  const viewer = page.getByRole('dialog', { name: 'Viewing report.html' });
  await expect(viewer).toBeVisible();
  const frame = viewer.locator('iframe[srcdoc]');
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  await expect(viewer.frameLocator('iframe[srcdoc]').locator('#out')).toHaveText('script ran: 2');

  // next → the Markdown document, rendered, with a Source toggle
  await viewer.getByRole('button', { name: 'Previous file' }).first().click();
  const mdViewer = page.getByRole('dialog', { name: 'Viewing report.md' });
  await expect(mdViewer.getByRole('heading', { name: 'Release notes 2.0' })).toBeVisible();
  await expect(mdViewer.getByRole('table')).toContainText('Tokens act as an agent');
  await mdViewer.getByRole('radio', { name: 'Source' }).click();
  await expect(mdViewer).toContainText('| Area | Change |');
  await page.keyboard.press('Escape');
  await expect(mdViewer).toBeHidden();

  // /f/{board}/{ticket}/{file}: the same viewer as a full page, no app shell
  await msg.getByRole('button', { name: 'Open report.html' }).click();
  const href = await page
    .getByRole('dialog', { name: 'Viewing report.html' })
    .getByTitle('Open in new tab')
    .getAttribute('href');
  expect(href).toBe(`/f/${b.key}/${t.key}/${html.fileId}`);
  const tab = await context.newPage();
  await tab.goto(href!);
  const full = tab.getByRole('region', { name: 'Viewing report.html' });
  await expect(full).toBeVisible();
  await expect(full.frameLocator('iframe[srcdoc]').locator('#out')).toHaveText('script ran: 2');
  await expect(tab.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await tab.close();
});
