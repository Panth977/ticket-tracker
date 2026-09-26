/**
 * The agent's event inbox and the token gate (docs/plan/agents.html §D–§F):
 *
 *   1. A person assigns the agent IN THE APP (the assignee picker lists agents
 *      next to people); the token's REST feed and its SSE stream both deliver
 *      the 'assigned' event, and ack clears it.
 *   2. Scopes are granular: a Worker token without tickets:move is refused
 *      (403 problem+json) by REST and by MCP, while a token that has it works.
 */
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SCOPE_PRESETS, type Scope } from '@tm/shared';
import {
  API_URL,
  call,
  eventually,
  http,
  newBoard,
  newPerson,
  read,
  stage,
  type Person,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const bearer = (key: string) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
});

/** An agent on `boardId` plus a token acting as it with exactly these scopes. */
async function agentWithToken(owner: Person, boardId: string, name: string, scopes: Scope[]) {
  const { agentId } = await call(owner, 'agentCreate', { name, systemPrompt: `# ${name}` });
  await call(owner, 'boardAgentSet', { boardId, agentId, role: 'editor' });
  const { key } = await call(owner, 'apiKeyCreate', {
    name: `tok-${name.toLowerCase()}`,
    boardId,
    actsAs: { kind: 'agent', id: agentId },
    scopes,
  });
  return { agentId, key };
}

/** Read an SSE stream until `match` sees the event it wants (or time runs out). */
async function sse(
  key: string,
  path: string,
  match: (e: Record<string, unknown>) => boolean,
  ms = 30_000,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(API_URL + path, {
      headers: { ...bearer(key), accept: 'text/event-stream' },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const f of frames) {
        if (!/^event: event$/m.test(f)) continue; // ping keep-alives
        const data = /^data: (.*)$/m.exec(f)?.[1];
        if (!data) continue;
        const e = JSON.parse(data) as Record<string, unknown>;
        if (match(e)) {
          void reader.cancel();
          return e;
        }
      }
    }
    throw new Error('the stream ended without the event');
  } finally {
    clearTimeout(timer);
  }
}

test('a person assigns the agent in the app: the REST feed and the SSE stream both get "assigned"', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Inbox board' });
  const { agentId, key } = await agentWithToken(ada, b.id, 'Watcher', [...SCOPE_PRESETS.worker]);
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Needs an agent',
    stageId: stage(b, 'To do'),
  });

  // The stream is listening before the change is made.
  const streamed = sse(
    key,
    '/v1/events/stream',
    (e) => e.type === 'assigned' && e.ticket_key === t.key,
  );

  // Ada assigns the agent from the ticket's Details pane — agents sit in the
  // same picker as people, with their badge.
  await signIn(page, ada.email, `/t/${t.key}`);
  const details = page.getByRole('complementary', { name: 'Details' });
  await details.getByRole('button', { name: 'Assignees' }).click();
  const option = page.getByRole('option', { name: /Watcher/ });
  await expect(option).toBeVisible();
  await expect(option.locator('[data-agent-mark], [data-agent-badge]').first()).toBeVisible();
  await option.click();
  await page.keyboard.press('Escape');
  await eventually('the assignment', async () =>
    (await read(`boards/${b.id}/tickets/${t.ticketId}`))?.assigneeUids?.includes(agentId),
  );

  const fromStream = await streamed;
  expect(fromStream).toMatchObject({
    type: 'assigned',
    ticket_key: t.key,
    actor: { id: ada.uid, kind: 'user' },
  });

  // The same event on the cursor feed, and ack clears it.
  const feed = await http('/v1/events', { headers: bearer(key) });
  expect(feed.status).toBe(200);
  expect(feed.body.data.map((e: { id: string }) => e.id)).toContain(fromStream.id);
  const ack = await http('/v1/events/ack', {
    method: 'POST',
    headers: bearer(key),
    body: JSON.stringify({ ids: [fromStream.id] }),
  });
  expect(ack.status).toBe(200);
  expect(ack.body.acked).toBe(1);
  const unacked = await http('/v1/events?unacked=1', { headers: bearer(key) });
  expect(unacked.body.data.map((e: { id: string }) => e.id)).not.toContain(fromStream.id);
});

test('granular scopes: without tickets:move the token is refused by REST and by MCP; with it the move works', async () => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Scopes board' });
  const noMove = SCOPE_PRESETS.worker.filter((s) => s !== 'tickets:move') as Scope[];
  const weak = await agentWithToken(ada, b.id, 'Commenter', noMove);
  const strong = await agentWithToken(ada, b.id, 'Mover', [...SCOPE_PRESETS.worker]);
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Move me',
    stageId: stage(b, 'To do'),
  });
  const review = stage(b, 'Review');

  const move = (key: string) =>
    http(`/v1/tickets/${t.key}/move`, {
      method: 'POST',
      headers: bearer(key),
      body: JSON.stringify({ stage: 'Review' }),
    });

  const denied = await move(weak.key);
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect(denied.headers.get('content-type')).toContain('application/problem+json');
  expect(JSON.stringify(denied.body)).toMatch(/tickets:move/);
  // Refused, not applied — and a patch that only changes the stage is refused too.
  expect((await read(`boards/${b.id}/tickets/${t.ticketId}`))!.stageId).toBe(stage(b, 'To do'));
  const patched = await http(`/v1/tickets/${t.key}`, {
    method: 'PATCH',
    headers: bearer(weak.key),
    body: JSON.stringify({ stage: 'Review' }),
  });
  expect(patched.status).toBe(403);
  // What it DOES have still works (comments:write).
  const said = await http(`/v1/tickets/${t.key}/messages`, {
    method: 'POST',
    headers: bearer(weak.key),
    body: JSON.stringify({ body_markdown: 'I cannot move this.' }),
  });
  expect(said.status, JSON.stringify(said.body)).toBe(201);

  // MCP: move_ticket is hidden from tools/list and refused when called anyway.
  const mcp = new Client({ name: 'e2e-weak', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: bearer(weak.key) },
    }),
  );
  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  expect(tools).toContain('post_message');
  expect(tools).not.toContain('move_ticket');
  const refused = await mcp.callTool({
    name: 'move_ticket',
    arguments: { key: t.key, stage: 'Review' },
  });
  expect(refused.isError).toBe(true);
  await mcp.close();

  // The token that has tickets:move moves it.
  const ok = await move(strong.key);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect((await read(`boards/${b.id}/tickets/${t.ticketId}`))!.stageId).toBe(review);
});
