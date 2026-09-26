/**
 * PHASE 3 END TO END (docs/plan/agents.html §L): what a person SEES while an
 * agent works, driven by a real MCP client holding nothing but a Worker token.
 *
 *   MCP  heartbeat 'working'          → 🟢 Working · Reading the exporter
 *   MCP  set_tasklist + update_task_item → the right pane's bar moves 0/3 → 1/3
 *   UI   the board card carries the same '1/3' chip and a ❓ badge
 *   MCP  ask_question (blocking)      → the form card in the thread
 *   UI   Ada answers it in the browser → the card locks, 'Answered by Ada'
 *   MCP  get_events                   → question_answered, values and all
 *   ——   the beats stop (the status doc is aged by hand: the browser has no
 *        test clock it could share with the server)  → 🔴 No signal for 3 min
 *   MCP  heartbeat 'done'             → ⚪ Finished · 10:42
 *
 * Every assertion is on what the SCREEN says, because §L is a spec about
 * visibility; the wire shapes are pinned by qaqc/e2e/api/phase3.spec.ts and
 * backend/test/platform/phase3-api.emu.test.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SCOPE_PRESETS, agentStatusId } from '@tm/shared';
import { admin, API_URL, call, eventually, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** The JSON a tool answered with (every tool answers one text block of JSON). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool payloads are shaped per tool; each call asserts what it needs
function payload(r: unknown): any {
  const res = r as CallToolResult;
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
  return JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
}

/** A screenshot in the report: this is the step p3-web asked for pictures of. */
async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test('§L: an agent works, and the person watches it happen', async ({ page }) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Agent visibility' });

  // ── the orchestrator's credentials: an agent on the board, a Worker token ──
  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Builder',
    description: 'Implements tickets and reports back',
    systemPrompt: '# Builder\n\nAsk before guessing.',
  });
  await call(ada, 'boardAgentSet', { boardId: b.id, agentId, role: 'editor' });
  const { key: token } = await call(ada, 'apiKeyCreate', {
    name: 'orch-visibility',
    boardId: b.id,
    actsAs: { kind: 'agent', id: agentId },
    // §L4: questions:write, tasklists:write and status:write are all in Worker.
    scopes: [...SCOPE_PRESETS.worker],
  });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Add CSV export',
    stageId: stage(b, 'In progress'),
    assigneeUids: [agentId],
  });

  const mcp = new Client({ name: 'e2e-orchestrator', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  expect(tools).toEqual(
    expect.arrayContaining([
      'heartbeat',
      'set_tasklist',
      'update_task_item',
      'ask_question',
      'get_events',
    ]),
  );

  // ── 1. 'I am on it' (§L3) ──────────────────────────────────────────────────
  const beat = payload(
    await mcp.callTool({
      name: 'heartbeat',
      arguments: {
        ticket: t.key,
        state: 'working',
        message: 'Reading the exporter',
        progress: 0.1,
      },
    }),
  );
  expect(beat).toMatchObject({ state: 'working', health: 'working', ticket_key: t.key });

  await signIn(page, ada.email, `/t/${t.key}`);
  // The drawer header's own health line (avatars elsewhere carry a dot too).
  const health = page.locator('header [data-health]').first();
  await expect(health).toHaveAttribute('data-health', 'working');
  // The line is drawn in pieces, so the composed label is read off `title`
  // ('Builder · Working · Reading the exporter'), which healthLook() builds.
  await expect(health).toHaveAttribute('title', /Builder · Working · Reading the exporter/);

  // ── 2. the plan, and it moves while the page stays open (§L2) ─────────────
  const plan = payload(
    await mcp.callTool({
      name: 'set_tasklist',
      arguments: {
        key: t.key,
        list_id: 'plan',
        title: 'Plan: add CSV export',
        items: [
          { id: 'read', title: 'Read the exporter' },
          { id: 'write', title: 'Write the CSV writer', status: 'doing' },
          { id: 'tests', title: 'Tests' },
        ],
      },
    }),
  );
  expect(plan).toMatchObject({ id: 'plan', progress: { done: 0, total: 3 } });

  const list = page.locator('[data-tasklist="plan"]');
  await expect(list).toBeVisible();
  await expect(list.getByText('Plan: add CSV export')).toBeVisible();
  await expect(list.locator('[data-progress]')).toHaveText('0 / 3');
  // The item being worked on is the one with the spinner.
  await expect(list.locator('[data-item-status="doing"]')).toContainText('Write the CSV writer');
  // Creating a list is one of the two things that speak in the thread (§L2).
  await expect(page.getByRole('region', { name: 'Thread' })).toContainText(
    'Builder added a plan: Plan: add CSV export',
  );
  await shot(page, 'tasklist-in-progress');

  payload(
    await mcp.callTool({
      name: 'update_task_item',
      arguments: { key: t.key, list_id: 'plan', item_id: 'read', status: 'done' },
    }),
  );
  await expect(list.locator('[data-progress]')).toHaveText('1 / 3');
  await expect(list.locator('[data-item-status="done"]')).toContainText('Read the exporter');
  // Ticking an item says nothing in the thread — that is the whole point (§L2).
  await expect(page.getByRole('region', { name: 'Thread' })).not.toContainText('Read the exporter');

  // ── 3. the question the work depends on (§L1) ─────────────────────────────
  const asked = payload(
    await mcp.callTool({
      name: 'ask_question',
      arguments: {
        key: t.key,
        title: 'Which database should the report use?',
        body: 'Both are wired up already.',
        fields: [
          {
            id: 'db',
            label: 'Database',
            type: 'single',
            required: true,
            options: [
              { id: 'pg', label: 'Postgres' },
              { id: 'bq', label: 'BigQuery', description: 'costs per query' },
            ],
          },
          { id: 'why', label: 'Why?', type: 'text' },
        ],
        allow_comment: true,
        to: [ada.email],
        blocking: true,
      },
    }),
  );
  expect(asked.status).toBe('open');

  const card = page.locator('[data-question]').first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-question-status', 'open');
  await expect(
    card.getByRole('heading', { name: 'Which database should the report use?' }),
  ).toBeVisible();
  await expect(card).toContainText('Both are wired up already.');
  // `to` is set, so the card says whom it waits for (§L1).
  await expect(card).toContainText(`Waiting for ${ada.name}`);
  // and the header badge says a blocking question is open.
  await expect(page.locator('[data-waiting]').first()).toBeVisible();
  await shot(page, 'question-open');

  // ── 4. the board card knows both without being opened (§L1 · §L2) ─────────
  await page.goto(`/b/${b.key}`);
  const boardCard = page.getByRole('button', { name: new RegExp(`^${t.key} `) }).first();
  await expect(boardCard).toBeVisible();
  await expect(boardCard.locator('[data-tasks]')).toHaveAttribute('data-tasks', '1/3');
  await expect(boardCard.locator('[data-waiting]')).toBeVisible();
  await shot(page, 'board-card-signals');

  // ── 5. Ada answers it, in the browser ─────────────────────────────────────
  await page.goto(`/t/${t.key}`);
  const form = page.locator('[data-question]').first();
  await form.getByRole('radio', { name: /BigQuery/ }).check();
  await form.getByLabel('Why?').fill('the report scans everything');
  await form.getByLabel('Anything else?').fill('ping me if that is wrong');
  await form.getByRole('button', { name: 'Submit' }).click();

  await expect(form).toHaveAttribute('data-question-status', 'answered');
  await expect(form).toContainText('BigQuery');
  await expect(form).toContainText(`Answered by ${ada.name}`);
  // The answer is also Ada's own reply bubble in the thread (§L1).
  const thread = page.getByRole('region', { name: 'Thread' });
  await expect(thread.getByRole('article', { name: 'Message from you' }).last()).toContainText(
    'BigQuery',
  );
  await expect(page.locator('[data-waiting]')).toHaveCount(0);
  await shot(page, 'question-answered');

  // ── 6. and it reaches the agent, values and all (§L4) ─────────────────────
  const event = await eventually('the question_answered event', async () => {
    const feed = payload(await mcp.callTool({ name: 'get_events', arguments: {} }));
    return feed.data?.find((e: { type: string }) => e.type === 'question_answered') ?? null;
  });
  expect(event.question.values).toEqual({ db: 'bq', why: 'the report scans everything' });
  expect(event.question.comment).toBe('ping me if that is wrong');
  expect(event.question.answered_by.id).toBe(ada.uid);

  // ── 7. the beats stop: 🔴 No signal (§L3) ─────────────────────────────────
  // The server stamps lastBeatAt itself, so 'three minutes of silence' is made
  // by ageing the status document — the same thing a dead orchestrator does.
  await admin()
    .db.doc(`boards/${b.id}/agentStatus/${agentStatusId(agentId, t.ticketId)}`)
    .update({ lastBeatAt: Date.now() - 3 * 60_000 });
  await expect(health).toHaveAttribute('data-health', 'stale');
  await expect(health).toHaveAttribute('title', /No signal for 3 min/);
  await shot(page, 'health-no-signal');

  // ── 8. and the end of the run: ⚪ Finished (§L3) ──────────────────────────
  const done = payload(
    await mcp.callTool({
      name: 'heartbeat',
      arguments: { ticket: t.key, state: 'done', message: 'CSV export shipped' },
    }),
  );
  expect(done).toMatchObject({ state: 'done', health: 'done' });
  expect(done.ended_at).toBeTruthy();
  await expect(health).toHaveAttribute('data-health', 'done');
  await expect(health).toHaveAttribute('title', /Finished/);
  await shot(page, 'health-finished');

  await mcp.close();
});
