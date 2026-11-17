/**
 * ORCH-73 — answer_question / list_questions over MCP: a person's assistant
 * (account token) answers an agent's question card by labels, exactly like
 * Submit in the app — the card locks and the agent hears question_answered.
 * An agent token never gets the tool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { questionId, SCOPE_PRESETS, type Scope } from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { call, setupEmulators } from '../harness/index.js';
import { asAgent } from '../agents/helpers.js';
import { people } from '../tickets/helpers.js';
import { agentTokenFor } from '../platform/helpers.js';
import { inboxOf, messageOf, scene, waitingOnOf } from './helpers.js';

setupEmulators();

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'manager', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}
type Res = { isError?: boolean; content: { text: string }[] };
const tool = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as Res;
const body = <T>(r: Res): T => JSON.parse(r.content[0]!.text) as T;

const FIELDS = [
  {
    id: 'f_db',
    label: 'Database',
    type: 'single' as const,
    options: [
      { id: 'o_pg', label: 'Postgres' },
      { id: 'o_my', label: 'MySQL' },
    ],
    required: true,
  },
  { id: 'f_ok', label: 'Ship it', type: 'boolean' as const },
];

async function asked(fields: unknown[] = FIELDS, clientId = 'q-1') {
  const { asha } = await people('asha');
  const sc = await scene(asha);
  const { messageId } = await asAgent(sc.agent, 'questionAsk', {
    boardId: sc.boardId,
    ticketId: sc.ticketId,
    title: 'Which database?',
    fields,
    allowComment: true,
    clientId,
  });
  const account = await call(asha, 'apiKeyCreate', {
    name: 'Manager',
    kind: 'account' as const,
    scopes: [...SCOPE_PRESETS.fullAccount] as Scope[],
  });
  return { asha, sc, messageId, account };
}

describe('ORCH-73 answer_question', () => {
  it('answers by ticket key and labels; the card locks and the agent wakes', async () => {
    const { asha, sc, messageId, account } = await asked();
    const c = await mcpClient(account.key);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['answer_question', 'list_questions']));
    expect(names).not.toContain('question_answer');

    const key = `${sc.boardKey}-1`;
    const open = body<{ id: string; fields: { label: string }[] }[]>(
      await tool(c, 'list_questions', {}),
    );
    expect(open.map((q) => q.id)).toContain(questionId(sc.ticketId, messageId));
    expect(body<unknown[]>(await tool(c, 'list_questions', { ticket: key }))).toHaveLength(1);

    const r = await tool(c, 'answer_question', {
      ticket: key,
      answers: { database: 'postgres', 'Ship it': 'yes' },
      comment: 'go',
    });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(body<{ status: string }>(r).status).toBe('answered');

    const card = await messageOf(sc.boardId, sc.ticketId, messageId);
    expect(card.question).toMatchObject({
      status: 'answered',
      answer: { values: { f_db: 'o_pg', f_ok: true }, comment: 'go', by: asha.uid },
    });
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toBeNull();
    const events = await inboxOf(sc.agent.id);
    expect(events.find((e) => e.type === 'question_answered')?.question).toMatchObject({
      status: 'answered',
      values: { f_db: 'o_pg' },
    });
    expect(body<unknown[]>(await tool(c, 'list_questions', {}))).toHaveLength(0);

    // Answered twice: a clear error, not a silent no-op.
    expect(
      (await tool(c, 'answer_question', { id: questionId(sc.ticketId, messageId), answer: 'x' }))
        .isError,
    ).toBe(true);
  });

  it('`answer` fills a one-field form; a wrong option names the choices', async () => {
    const { sc, messageId, account } = await asked([
      { id: 'token', label: "Token (tm_live_…) or 'done'", type: 'text' as const, required: true },
    ]);
    const c = await mcpClient(account.key);
    const id = questionId(sc.ticketId, messageId);
    const r = await tool(c, 'answer_question', { id, answer: 'done' });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    const card = await messageOf(sc.boardId, sc.ticketId, messageId);
    expect(card.question?.answer?.values).toEqual({ token: 'done' });
  });

  it('refuses an unknown option or field with the valid names', async () => {
    const { sc, messageId, account } = await asked();
    const c = await mcpClient(account.key);
    const id = questionId(sc.ticketId, messageId);
    const bad = await tool(c, 'answer_question', { id, answers: { Database: 'Oracle' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('Postgres / MySQL');
    const nofield = await tool(c, 'answer_question', { id, answers: { Colour: 'red' } });
    expect(nofield.isError).toBe(true);
    expect(nofield.content[0]!.text).toContain('"Database"');
  });

  it('an agent token never gets answer_question', async () => {
    const { asha, sc } = await asked();
    const t = await agentTokenFor(asha, sc.agent.id, { keepOthers: true });
    const names = (await (await mcpClient(t.key)).listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('answer_question');
  });
});
