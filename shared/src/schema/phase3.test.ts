/**
 * Phase 3 contracts (docs/plan/agents.html §L): questions with options, ticket
 * task lists, the heartbeat, and the commands / scopes / API shapes they add.
 */
import { describe, expect, it } from 'vitest';
import {
  agentSilenceDue,
  agentStatusId,
  AgentStatusSchema,
  deriveAgentHealth,
  HEARTBEAT_STALE_MS,
  parseAgentStatusId,
} from './agentStatus.js';
import {
  answerValueIssue,
  isEmptyAnswer,
  MAX_QUESTION_FIELDS,
  parseQuestionId,
  QuestionFieldSchema,
  QuestionSchema,
  questionAddresses,
  questionId,
  questionIsOpen,
  questionStatus,
} from './question.js';
import { MessageSchema, isQuestionMessage } from './ticket.js';
import { TasklistSchema, tasklistComplete, tasklistProgress } from './tasklist.js';
import {
  fixtures,
  questionMessageFixture,
  AGENT_ID,
  T0,
  TICKET_ID,
  UID_ASHA,
  UID_PRIYA,
} from './fixtures.js';
import { can, canEditTasklist, canHeartbeat, type CanBoard } from '../logic/can.js';
import { answerDefaults, canAnswerQuestion, validateAnswer } from '../logic/question.js';
import { COMMANDS } from '../commands/index.js';
import {
  McpToolSchemas,
  MCP_TOOLS,
  REST_ROUTES,
  RestAskQuestionBodySchema,
  RestHeartbeatBodySchema,
} from '../api/index.js';
import {
  ChannelMatrixSchema,
  defaultChannelMatrix,
  NOTIFY_EVENTS,
  SCOPE_PRESETS,
  TOKEN_SCOPES,
  type Scope,
} from '../types/index.js';
import { AGENT_EVENT_TYPES, AgentInboxEventSchema } from './agent.js';

const question = questionMessageFixture.question!;

describe('questions (§L1)', () => {
  it('a question message parses and narrows', () => {
    const m = MessageSchema.parse(questionMessageFixture);
    expect(isQuestionMessage(m)).toBe(true);
    expect(isQuestionMessage(MessageSchema.parse(fixtures.messages))).toBe(false);
    expect(m.question?.fields).toHaveLength(2);
  });

  it('single / multi need options; other types refuse them', () => {
    expect(QuestionFieldSchema.safeParse({ id: 'f', label: 'x', type: 'single' }).success).toBe(
      false,
    );
    expect(
      QuestionFieldSchema.safeParse({
        id: 'f',
        label: 'x',
        type: 'text',
        options: [{ id: 'o', label: 'o' }],
      }).success,
    ).toBe(false);
    expect(
      QuestionFieldSchema.safeParse({
        id: 'f',
        label: 'x',
        type: 'multi',
        options: [
          { id: 'o', label: 'a' },
          { id: 'o', label: 'b' },
        ],
      }).success,
    ).toBe(false);
  });

  it("a field's default must itself be a legal answer", () => {
    const base = { id: 'f', label: 'How many?', type: 'number' as const };
    expect(QuestionFieldSchema.safeParse({ ...base, default: 3 }).success).toBe(true);
    expect(QuestionFieldSchema.safeParse({ ...base, default: 'three' }).success).toBe(false);
    expect(
      QuestionFieldSchema.safeParse({
        id: 'f',
        label: 'x',
        type: 'single',
        options: [{ id: 'a', label: 'A' }],
        default: 'b',
      }).success,
    ).toBe(false);
    expect(answerDefaults({ fields: [{ ...base, default: 3 }] })).toEqual({ f: 3 });
  });

  it('1–10 fields', () => {
    const field = (i: number) => ({ id: `f${i}`, label: `Field ${i}`, type: 'text' as const });
    const q = (n: number) =>
      QuestionSchema.safeParse({
        ...question,
        fields: Array.from({ length: n }, (_, i) => field(i)),
      });
    expect(q(0).success).toBe(false);
    expect(q(MAX_QUESTION_FIELDS).success).toBe(true);
    expect(q(MAX_QUESTION_FIELDS + 1).success).toBe(false);
  });

  it('answer values are judged against the field type', () => {
    const single = { type: 'single' as const, options: [{ id: 'o_pg', label: 'Postgres' }] };
    expect(answerValueIssue(single, 'o_pg')).toBeNull();
    expect(answerValueIssue(single, 'o_bq')).toMatch(/one of the options/);
    expect(answerValueIssue(single, ['o_pg'])).toMatch(/option id/);
    const multi = {
      type: 'multi' as const,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    };
    expect(answerValueIssue(multi, ['a', 'b'])).toBeNull();
    expect(answerValueIssue(multi, ['a', 'a'])).toMatch(/twice/);
    expect(answerValueIssue({ type: 'number' }, '3')).toMatch(/number/);
    expect(answerValueIssue({ type: 'boolean' }, true)).toBeNull();
    expect(answerValueIssue({ type: 'date' }, T0)).toBeNull();
    expect(answerValueIssue({ type: 'date' }, -1)).toMatch(/date/);
    expect(answerValueIssue({ type: 'longText' }, 'x'.repeat(20_001))).toMatch(/at most/);
  });

  it('blank answers: required refuses, optional drops', () => {
    for (const v of [undefined, null, '', '  ', []]) expect(isEmptyAnswer(v)).toBe(true);
    expect(isEmptyAnswer(false)).toBe(false);
    expect(isEmptyAnswer(0)).toBe(false);

    const bad = validateAnswer(question, { f_note: 'careful' });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]).toMatchObject({ fieldId: 'f_db' });

    const ok = validateAnswer(question, { f_db: 'o_pg', f_note: '' });
    expect(ok.ok).toBe(true);
    expect(ok.values).toEqual({ f_db: 'o_pg' });
  });

  it('unknown fields and unwanted comments are refused', () => {
    expect(validateAnswer(question, { f_db: 'o_pg', f_nope: 'x' }).issues).toEqual([
      { fieldId: null, message: "Unknown field 'f_nope'" },
    ]);
    expect(validateAnswer(question, { f_db: 'o_pg' }, 'and one more thing').ok).toBe(true);
    expect(validateAnswer({ ...question, allowComment: false }, { f_db: 'o_pg' }, 'hi').ok).toBe(
      false,
    );
  });

  it('status: an expiry that has passed reads as expired, an answer wins', () => {
    const open = { status: 'open' as const, expiresAt: null };
    expect(questionStatus(open, T0)).toBe('open');
    expect(questionStatus({ status: 'open', expiresAt: T0 }, T0)).toBe('expired');
    expect(questionStatus({ status: 'open', expiresAt: T0 + 1 }, T0)).toBe('open');
    expect(questionStatus({ status: 'answered', expiresAt: T0 - 1 }, T0)).toBe('answered');
    expect(questionIsOpen({ status: 'cancelled', expiresAt: null }, T0)).toBe(false);
  });

  it('`to` narrows who may answer', () => {
    expect(questionAddresses({ to: null }, UID_PRIYA)).toBe(true);
    expect(questionAddresses({ to: [] }, UID_PRIYA)).toBe(true);
    expect(questionAddresses({ to: [UID_ASHA] }, UID_PRIYA)).toBe(false);
    expect(questionAddresses({ to: [UID_ASHA] }, UID_ASHA)).toBe(true);
  });

  it('question ids round-trip', () => {
    const id = questionId(TICKET_ID, 'msg_1');
    expect(id).toBe(`${TICKET_ID}.msg_1`);
    expect(parseQuestionId(id)).toEqual({ ticketId: TICKET_ID, messageId: 'msg_1' });
    expect(parseQuestionId('nope')).toBeNull();
    expect(() => questionId('a.b', 'msg_1')).toThrow();
  });
});

describe('task lists (§L2)', () => {
  const list = fixtures.tasklists;

  it('≤ 100 items, known statuses', () => {
    expect(TasklistSchema.safeParse(list).success).toBe(true);
    const item = (i: number) => ({
      id: `it_${i}`,
      title: `t${i}`,
      status: 'todo' as const,
      updatedAt: T0,
    });
    expect(
      TasklistSchema.safeParse({ ...list, items: Array.from({ length: 100 }, (_, i) => item(i)) })
        .success,
    ).toBe(true);
    expect(
      TasklistSchema.safeParse({ ...list, items: Array.from({ length: 101 }, (_, i) => item(i)) })
        .success,
    ).toBe(false);
    expect(
      TasklistSchema.safeParse({ ...list, items: [{ ...item(1), status: 'blocked' }] }).success,
    ).toBe(false);
  });

  it('progress counts done + skipped and finds the running item', () => {
    const p = tasklistProgress(list);
    expect(p).toMatchObject({ total: 3, done: 1, doing: 1, todo: 1, settled: 1, label: '1 / 3' });
    expect(p.current?.id).toBe('it_2');
    expect(p.fraction).toBeCloseTo(1 / 3);
    expect(tasklistComplete(list)).toBe(false);

    const finished = {
      items: [
        { ...list.items[0]!, status: 'done' as const },
        { ...list.items[1]!, status: 'skipped' as const },
      ],
    };
    expect(tasklistProgress(finished).label).toBe('2 / 2');
    expect(tasklistComplete(finished)).toBe(true);
    expect(tasklistProgress({ items: [] })).toMatchObject({
      fraction: 0,
      label: '0 / 0',
      current: null,
    });
  });
});

describe('heartbeat (§L3)', () => {
  const status = fixtures.agentStatus;

  it("doc ids are {agentId}__{ticketId|'_'}", () => {
    expect(agentStatusId(AGENT_ID, TICKET_ID)).toBe(`${AGENT_ID}__${TICKET_ID}`);
    expect(agentStatusId(AGENT_ID, null)).toBe(`${AGENT_ID}___`);
    expect(parseAgentStatusId(agentStatusId(AGENT_ID, TICKET_ID))).toEqual({
      agentId: AGENT_ID,
      ticketId: TICKET_ID,
    });
    expect(parseAgentStatusId(agentStatusId(AGENT_ID, null))).toEqual({
      agentId: AGENT_ID,
      ticketId: null,
    });
    expect(parseAgentStatusId('nope')).toBeNull();
    expect(parseAgentStatusId(`uid_asha__${TICKET_ID}`)).toBeNull();
    expect(() => agentStatusId(AGENT_ID, 'a__b')).toThrow();
    expect(AgentStatusSchema.safeParse({ ...status, progress: 1.5 }).success).toBe(false);
  });

  it('the 75-second rule', () => {
    const beat = (state: 'working' | 'idle' | 'done' | 'error', lastBeatAt: number) => ({
      state,
      lastBeatAt,
    });
    expect(deriveAgentHealth(null, T0)).toBe('none');
    expect(deriveAgentHealth(undefined, T0)).toBe('none');
    expect(deriveAgentHealth(beat('working', T0), T0)).toBe('working');
    expect(deriveAgentHealth(beat('working', T0 - HEARTBEAT_STALE_MS), T0)).toBe('working');
    expect(deriveAgentHealth(beat('working', T0 - HEARTBEAT_STALE_MS - 1), T0)).toBe('stale');
    // Only 'working' goes stale: the others are statements that stand.
    for (const s of ['idle', 'done', 'error'] as const) {
      expect(deriveAgentHealth(beat(s, T0 - 86_400_000), T0)).toBe(s);
    }
  });

  it('the silence sweep fires once per silence', () => {
    const quiet = { state: 'working' as const, lastBeatAt: T0, silenceNotifiedAt: null };
    expect(agentSilenceDue(quiet, T0 + 60_000)).toBe(false);
    expect(agentSilenceDue(quiet, T0 + 5 * 60_000)).toBe(true);
    expect(agentSilenceDue({ ...quiet, silenceNotifiedAt: T0 + 60_000 }, T0 + 5 * 60_000)).toBe(
      false,
    );
    // A beat since the notice re-arms it.
    expect(
      agentSilenceDue(
        { state: 'working', lastBeatAt: T0 + 120_000, silenceNotifiedAt: T0 + 60_000 },
        T0 + 10 * 60_000,
      ),
    ).toBe(true);
    expect(
      agentSilenceDue({ state: 'done', lastBeatAt: T0, silenceNotifiedAt: null }, T0 + 86_400_000),
    ).toBe(false);
  });
});

describe('permissions (§L1, §L2, §L3)', () => {
  const board = (over: Partial<CanBoard> = {}): CanBoard => ({
    id: 'b1',
    access: { ad: 'admin', ed: 'editor', co: 'commenter', vi: 'viewer', [AGENT_ID]: 'commenter' },
    stageGrants: {},
    settings: { allowDelete: false },
    ...over,
  });
  const open = { to: null, status: 'open' as const, expiresAt: null };

  it('answering: commenter and above, and in `to` when it is set', () => {
    expect(canAnswerQuestion({ actor: 'co' }, board(), open, T0)).toBe(true);
    expect(canAnswerQuestion({ actor: 'ed' }, board(), open, T0)).toBe(true);
    expect(canAnswerQuestion({ actor: 'vi' }, board(), open, T0)).toBe(false);
    expect(canAnswerQuestion({ actor: 'stranger' }, board(), open, T0)).toBe(false);
    expect(canAnswerQuestion({ actor: 'co' }, board(), { ...open, to: ['ed'] }, T0)).toBe(false);
    expect(canAnswerQuestion({ actor: 'ed' }, board(), { ...open, to: ['ed'] }, T0)).toBe(true);
    // Closed or expired: nobody, whatever their role.
    expect(canAnswerQuestion({ actor: 'ad' }, board(), { ...open, status: 'answered' }, T0)).toBe(
      false,
    );
    expect(canAnswerQuestion({ actor: 'ad' }, board(), { ...open, expiresAt: T0 - 1 }, T0)).toBe(
      false,
    );
    // A token needs questions:write.
    expect(canAnswerQuestion({ actor: 'ed', scopes: ['comments:write'] }, board(), open, T0)).toBe(
      false,
    );
    expect(canAnswerQuestion({ actor: 'ed', scopes: ['questions:write'] }, board(), open, T0)).toBe(
      true,
    );
  });

  it('task lists: editor+, or the list owner', () => {
    const mine = { owner: AGENT_ID };
    expect(canEditTasklist({ actor: 'ed' }, board(), { owner: 'co' })).toBe(true);
    expect(canEditTasklist({ actor: 'co' }, board(), { owner: 'ed' })).toBe(false);
    expect(canEditTasklist({ actor: AGENT_ID }, board(), mine)).toBe(true);
    expect(canEditTasklist({ actor: 'vi' }, board(), { owner: 'vi' })).toBe(false);
    // The owner's token still needs tasklists:write, and the right board.
    expect(canEditTasklist({ actor: AGENT_ID, scopes: ['tasklists:write'] }, board(), mine)).toBe(
      true,
    );
    expect(canEditTasklist({ actor: AGENT_ID, scopes: ['comments:write'] }, board(), mine)).toBe(
      false,
    );
    expect(
      canEditTasklist(
        { actor: AGENT_ID, scopes: ['tasklists:write'], boardIds: ['other'] },
        board(),
        mine,
      ),
    ).toBe(false);
  });

  it('heartbeat: the agent itself, or a board admin', () => {
    expect(canHeartbeat({ actor: AGENT_ID }, board(), AGENT_ID)).toBe(true);
    expect(canHeartbeat({ actor: 'co' }, board(), AGENT_ID)).toBe(false);
    expect(canHeartbeat({ actor: 'ad' }, board(), AGENT_ID)).toBe(true);
    expect(canHeartbeat({ actor: AGENT_ID, scopes: ['tasklists:write'] }, board(), AGENT_ID)).toBe(
      false,
    );
    expect(canHeartbeat({ actor: AGENT_ID, scopes: ['status:write'] }, board(), AGENT_ID)).toBe(
      true,
    );
  });

  it('asking is thread work: commenter and above', () => {
    expect(can({ actor: 'co' }, board(), 'ask')).toBe(true);
    expect(can({ actor: 'vi' }, board(), 'ask')).toBe(false);
  });
});

describe('the new scopes and commands (§L4)', () => {
  const NEW_SCOPES: Scope[] = ['questions:write', 'tasklists:write', 'status:write'];

  it('are token scopes, and part of the Worker preset', () => {
    for (const s of NEW_SCOPES) {
      expect(TOKEN_SCOPES).toContain(s);
      expect(SCOPE_PRESETS.worker).toContain(s);
      expect(SCOPE_PRESETS.readOnly).not.toContain(s);
    }
  });

  it('every phase-3 command names its scope and parses its request', () => {
    expect(COMMANDS.questionAsk.scopes).toEqual(['questions:write']);
    expect(COMMANDS.questionAnswer.scopes).toEqual(['questions:write']);
    expect(COMMANDS.questionCancel.scopes).toEqual(['questions:write']);
    expect(COMMANDS.tasklistSet.scopes).toEqual(['tasklists:write']);
    expect(COMMANDS.tasklistItemUpdate.scopes).toEqual(['tasklists:write']);
    expect(COMMANDS.tasklistDelete.scopes).toEqual(['tasklists:write']);
    expect(COMMANDS.agentHeartbeat.scopes).toEqual(['status:write']);

    const ref = { boardId: 'b1', ticketId: TICKET_ID };
    expect(
      COMMANDS.questionAsk.req.safeParse({
        ...ref,
        title: 'Which database?',
        fields: [
          { id: 'f', label: 'Database', type: 'single', options: [{ id: 'a', label: 'A' }] },
        ],
      }).success,
    ).toBe(true);
    expect(COMMANDS.questionAsk.req.safeParse({ ...ref, title: 'x', fields: [] }).success).toBe(
      false,
    );
    expect(
      COMMANDS.questionAnswer.req.safeParse({ ...ref, messageId: 'm1', values: { f: 'a' } })
        .success,
    ).toBe(true);
    expect(
      COMMANDS.tasklistItemUpdate.req.safeParse({ ...ref, listId: 'l1', itemId: 'i1' }).success,
    ).toBe(false);
    expect(
      COMMANDS.tasklistItemUpdate.req.safeParse({
        ...ref,
        listId: 'l1',
        itemId: 'i1',
        status: 'done',
      }).success,
    ).toBe(true);
    expect(
      COMMANDS.agentHeartbeat.req.safeParse({ boardId: 'b1', state: 'working', progress: 0.5 })
        .success,
    ).toBe(true);
    expect(
      COMMANDS.agentHeartbeat.req.safeParse({ boardId: 'b1', state: 'thinking' }).success,
    ).toBe(false);
  });
});

describe('REST and MCP (§L4)', () => {
  const route = (method: string, path: string) =>
    REST_ROUTES.find((r) => r.method === method && r.path === path);

  it('every route in §L4 exists with the right scope', () => {
    expect(route('POST', '/v1/tickets/{KEY}/questions')?.scopes).toEqual(['questions:write']);
    expect(route('GET', '/v1/questions/{id}')).toBeDefined();
    expect(route('POST', '/v1/questions/{id}/cancel')?.scopes).toEqual(['questions:write']);
    expect(route('PUT', '/v1/tickets/{KEY}/tasklists/{listId}')?.scopes).toEqual([
      'tasklists:write',
    ]);
    expect(route('PATCH', '/v1/tickets/{KEY}/tasklists/{listId}/items/{itemId}')?.scopes).toEqual([
      'tasklists:write',
    ]);
    expect(route('DELETE', '/v1/tickets/{KEY}/tasklists/{listId}')?.scopes).toEqual([
      'tasklists:write',
    ]);
    expect(route('POST', '/v1/heartbeat')?.scopes).toEqual(['status:write']);
  });

  it('REST bodies', () => {
    expect(
      RestAskQuestionBodySchema.safeParse({
        title: 'Which database?',
        fields: [
          { id: 'f', label: 'Database', type: 'single', options: [{ id: 'a', label: 'A' }] },
        ],
        to: ['asha@example.com'],
      }).success,
    ).toBe(true);
    expect(RestAskQuestionBodySchema.safeParse({ title: 'x', fields: [], extra: 1 }).success).toBe(
      false,
    );
    expect(
      RestHeartbeatBodySchema.safeParse({ state: 'working', message: 'Running tests (3/12)' })
        .success,
    ).toBe(true);
    expect(RestHeartbeatBodySchema.safeParse({ state: 'working', progress: 2 }).success).toBe(
      false,
    );
  });

  it('MCP tools', () => {
    for (const [tool, scope] of [
      ['ask_question', 'questions:write'],
      ['cancel_question', 'questions:write'],
      ['set_tasklist', 'tasklists:write'],
      ['update_task_item', 'tasklists:write'],
      ['delete_tasklist', 'tasklists:write'],
      ['heartbeat', 'status:write'],
    ] as const) {
      expect(MCP_TOOLS[tool].scopes).toEqual([scope]);
      expect(MCP_TOOLS[tool].readOnly).toBe(false);
    }
    expect(MCP_TOOLS.get_question.readOnly).toBe(true);
    expect(
      McpToolSchemas.ask_question.safeParse({
        key: 'ENG-1',
        title: 'Which database?',
        fields: [{ id: 'f', label: 'Database', type: 'text' }],
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.update_task_item.safeParse({ key: 'ENG-1', list_id: 'l1', item_id: 'i1' })
        .success,
    ).toBe(false);
    expect(
      McpToolSchemas.update_task_item.safeParse({
        key: 'ENG-1',
        list_id: 'l1',
        item_id: 'i1',
        status: 'failed',
      }).success,
    ).toBe(true);
    expect(McpToolSchemas.heartbeat.safeParse({ state: 'done' }).success).toBe(true);
    expect(McpToolSchemas.heartbeat.safeParse({ state: 'done', nope: 1 }).success).toBe(false);
  });
});

describe('notifications (§L1)', () => {
  it('people hear about a question; the asking agent hears the answer', () => {
    expect(NOTIFY_EVENTS).toContain('question');
    expect(defaultChannelMatrix().question).toEqual(['inApp', 'push', 'email']);
    expect(AGENT_EVENT_TYPES).toContain('question_answered');
    expect(AGENT_EVENT_TYPES).toContain('question_cancelled');
  });

  it('a matrix stored before phase 3 still parses, with the default', () => {
    const { question: _q, ...old } = defaultChannelMatrix();
    expect(ChannelMatrixSchema.parse(old).question).toEqual(['inApp', 'push', 'email']);
  });

  it('an answered event carries the values', () => {
    const e = AgentInboxEventSchema.parse({
      ...fixtures.agentInbox,
      type: 'question_answered',
      messageId: 'msg_q',
      question: {
        id: questionId(TICKET_ID, 'msg_q'),
        title: 'Which database?',
        status: 'answered',
        values: { f_db: 'o_pg' },
        answeredBy: UID_PRIYA,
      },
    });
    expect(e.question?.values).toEqual({ f_db: 'o_pg' });
    expect(
      AgentInboxEventSchema.safeParse({ ...fixtures.agentInbox, type: 'question_asked' }).success,
    ).toBe(false);
  });
});
