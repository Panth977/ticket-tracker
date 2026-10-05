/**
 * PHASE 5 (docs/plan/agents.html §N, §L1–§L2): MIXED OWNERSHIP on one ticket.
 *
 * §N's whole claim is that questions and task lists belong to the ticket, not
 * to agents — so the two halves have to meet in the middle:
 *
 *   agent  publishes its plan (MCP set_tasklist) and asks a blocking question
 *   Ada    ticks an item of the AGENT's list by hand (she is not its owner)
 *          and starts a list of her own next to it
 *   Grace  answers the AGENT's question in the browser
 *   card   the chip sums both lists; the ❓ badge clears when she answers
 *   agent  sees the answer and the hand-ticked item in its own feed
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SCOPE_PRESETS } from '@tm/shared';
import {
  API_URL,
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool payloads are shaped per tool
function payload(r: unknown): any {
  const res = r as CallToolResult;
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
  return JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
}

test('§N: a person ticks the agent’s list and answers its question; both lists live on one ticket', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada, { name: 'Mixed ownership' });
  await inviteAndAccept(ada, b.id, grace, 'editor');

  const { agentId } = await call(ada, 'agentCreate', {
    name: 'Builder',
    description: 'Implements tickets',
  });
  await call(ada, 'boardAgentSet', { boardId: b.id, agentId, role: 'editor' });
  const { key: token } = await call(ada, 'apiKeyCreate', {
    name: 'orch-mixed',
    boardId: b.id,
    actsAs: { kind: 'agent', id: agentId },
    scopes: [...SCOPE_PRESETS.worker],
  });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Add CSV export',
    stageId: stage(b, 'In progress'),
    assigneeUids: [agentId],
  });

  const mcp = new Client({ name: 'e2e-mixed', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );

  // ── the agent's plan and its question ─────────────────────────────────────
  payload(
    await mcp.callTool({
      name: 'set_tasklist',
      arguments: {
        key: t.key,
        list_id: 'plan',
        title: 'Plan: add CSV export',
        items: [
          { id: 'read', title: 'Read the exporter' },
          { id: 'write', title: 'Write the CSV writer' },
          { id: 'tests', title: 'Tests' },
        ],
      },
    }),
  );
  payload(
    await mcp.callTool({
      name: 'ask_question',
      arguments: {
        key: t.key,
        title: 'Which delimiter?',
        fields: [
          {
            id: 'sep',
            label: 'Delimiter',
            type: 'single',
            required: true,
            options: [
              { id: 'comma', label: 'Comma' },
              { id: 'semi', label: 'Semicolon' },
            ],
          },
        ],
        blocking: true,
      },
    }),
  );

  // ── Ada: the agent's list is hers to tick, though it is not hers ──────────
  await signIn(page, ada.email, `/t/${t.key}`);
  const pane = page.getByRole('complementary', { name: 'Details' });
  const agentList = pane.locator('[data-tasklist="plan"]');
  await expect(agentList.locator('[data-progress]')).toHaveText('0 / 3');

  const read1 = agentList.locator('[data-item]').filter({ hasText: 'Read the exporter' });
  await read1.getByRole('button', { name: /change status$/ }).click();
  await expect(read1).toHaveAttribute('data-item-status', 'doing');
  await read1.getByRole('button', { name: /change status$/ }).click();
  await expect(read1).toHaveAttribute('data-item-status', 'done');
  await expect(agentList.locator('[data-progress]')).toHaveText('1 / 3');
  // The list still belongs to the agent — a hand tick does not take it over.
  await eventually('the agent still owns its plan', async () => {
    // §W: task lists live on the ticket document, whole.
    const l = (await read(`boards/${b.id}/tickets/${t.ticketId}`))?.tasklists?.find(
      (x: { id: string }) => x.id === 'plan',
    );
    return (
      l?.owner === agentId &&
      l.items.find((i: { id: string }) => i.id === 'read')?.status === 'done'
    );
  });

  // ── and a list of her own, side by side ──────────────────────────────────
  await pane.getByRole('button', { name: 'New list' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task list' });
  await dialog.getByLabel('Title').fill('Ada: review');
  await dialog.getByLabel('Items').fill('Check the header row\nEyeball a 40k export');
  await dialog.getByRole('button', { name: 'Add list' }).click();
  await expect(dialog).toBeHidden();

  const mine = pane.locator('[data-tasklist]').filter({ hasText: 'Ada: review' });
  await expect(mine.locator('[data-progress]')).toHaveText('0 / 2');
  const header = mine.locator('[data-item]').filter({ hasText: 'Check the header row' });
  await header.getByRole('button', { name: /change status$/ }).click();
  await header.getByRole('button', { name: /change status$/ }).click();
  await expect(header).toHaveAttribute('data-item-status', 'done');

  // ── the card sums BOTH lists (§L2: one chip per ticket) ──────────────────
  await page.goto(`/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`^${t.key} `) }).first();
  await expect(card.locator('[data-tasks]')).toHaveAttribute('data-tasks', '2/5');
  await expect(card.locator('[data-waiting]')).toBeVisible();

  // ── Grace answers the AGENT's question, in the browser ───────────────────
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${t.key}`);
  const form = gp.locator('[data-question]').filter({ hasText: 'Which delimiter?' });
  await form.getByRole('radio', { name: 'Semicolon' }).check();
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form).toHaveAttribute('data-question-status', 'answered');
  await expect(form).toContainText(`Answered by ${grace.name}`);
  await ctx.close();

  // ── the agent sees the person's answer, values and all (§L4) ─────────────
  const event = await eventually('question_answered', async () => {
    const feed = payload(await mcp.callTool({ name: 'get_events', arguments: {} }));
    return feed.data?.find((e: { type: string }) => e.type === 'question_answered') ?? null;
  });
  expect(event.question.values).toEqual({ sep: 'semi' });
  expect(event.question.answered_by.id).toBe(grace.uid);

  // ── and the agent carries on with the list a person touched ──────────────
  const updated = payload(
    await mcp.callTool({
      name: 'update_task_item',
      arguments: { key: t.key, list_id: 'plan', item_id: 'write', status: 'done' },
    }),
  );
  expect(updated.progress).toMatchObject({ done: 2, total: 3 });
  await mcp.close();

  // the board card, refreshed: 3 of 5 settled, and nothing waiting any more
  await page.reload();
  const after = page.getByRole('button', { name: new RegExp(`^${t.key} `) }).first();
  await expect(after.locator('[data-tasks]')).toHaveAttribute('data-tasks', '3/5');
  await expect(after.locator('[data-waiting]')).toHaveCount(0);
});
