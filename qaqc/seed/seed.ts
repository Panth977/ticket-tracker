/**
 * Demo data for the local stack — run by `pnpm dev` once the api is up, or by
 * hand against running emulators:
 *
 *   pnpm --filter @tm/qaqc seed
 *
 * Everything goes through the real commands (POST /api/*), so derived data
 * (members, counts, keys, activity, search index, inbox items) is exactly what
 * the app itself would have written. Idempotent: a second run finds the ENG
 * board key claimed and stops.
 *
 *   People   Ada Lovelace  ada@demo.test     password "password"
 *            Grace Hopper  grace@demo.test   password "password"
 *   Boards   ENG  Engineering (kanban)  Ada admin, Grace editor
 *            OPS  Operations  (support) Grace admin, Ada editor
 *            MKT  Marketing   (blank)   Ada only
 *   Agent    Builder (ag_Bu1lderSeed00001, Ada's) on ENG as editor, assigned
 *            'Write the release notes for 2.0'; a Worker token acting as it
 *            is created on each run that finds none and printed once.
 *   Phase 3  With that token, Builder then does what an orchestrator does
 *            (agents.html §L): publishes its plan as a task list, asks Ada a
 *            blocking question with options, and beats 'working' on the
 *            ticket — so a fresh stack opens on a ticket that is visibly
 *            being worked on, with a form card waiting for an answer.
 *   Phase 5  The same two tools without an agent (agents.html §N): Grace
 *            asks Ada a blocking question on ENG-1 and Ada plans that
 *            ticket with a task list of her own.
 */
import {
  admin,
  board,
  call,
  doc,
  http,
  inviteAndAccept,
  person,
  priority,
  stage,
  text,
  type Person,
} from './client.js';
import { SCOPE_PRESETS } from '@tm/shared';

const DAY = 86_400_000;

async function main() {
  const t0 = Date.now();
  const { db } = admin();
  if ((await db.doc('boardKeys/ENG').get()).exists) {
    console.log('seed: already seeded (boardKeys/ENG exists)');
    // Stacks seeded before phase 2 still get the Builder agent.
    await seedAgent(
      await person('Ada Lovelace', 'ada@demo.test'),
      (await db.doc('boardKeys/ENG').get()).get('boardId') as string,
    );
    return;
  }

  const ada = await person('Ada Lovelace', 'ada@demo.test');
  const grace = await person('Grace Hopper', 'grace@demo.test');
  for (const [p, tz] of [
    [ada, 'Europe/London'],
    [grace, 'America/New_York'],
  ] as [Person, string][]) {
    await call(p, 'profileUpdate', { name: p.name, timezone: tz });
  }
  console.log('seed: people', ada.email, grace.email);

  // ── boards ────────────────────────────────────────────────────────────────
  const { boardId: engId } = await call(ada, 'boardCreate', {
    name: 'Engineering',
    key: 'ENG',
    template: 'kanban',
    color: 'blue',
  });
  const { boardId: opsId } = await call(grace, 'boardCreate', {
    name: 'Operations',
    key: 'OPS',
    template: 'support',
    color: 'green',
  });
  const { boardId: mktId } = await call(ada, 'boardCreate', {
    name: 'Marketing',
    key: 'MKT',
    template: 'blank',
    color: 'violet',
  });
  await inviteAndAccept(ada, engId, grace, 'editor');
  await inviteAndAccept(grace, opsId, ada, 'editor');
  const eng = await board(engId);
  const ops = await board(opsId);
  const mkt = await board(mktId);
  console.log('seed: boards', eng.key, ops.key, mkt.key);

  // ── tickets ───────────────────────────────────────────────────────────────
  const now = Date.now();
  const mk = async (
    who: Person,
    b: typeof eng,
    title: string,
    o: {
      stage?: string;
      priority?: string;
      assignees?: Person[];
      due?: number;
      description?: string;
    } = {},
  ) => {
    const r = await call(who, 'ticketCreate', {
      boardId: b.id,
      title,
      ...(o.stage ? { stageId: stage(b, o.stage) } : {}),
      ...(o.priority ? { priorityId: priority(b, o.priority) } : {}),
      ...(o.assignees ? { assigneeUids: o.assignees.map((p) => p.uid) } : {}),
      ...(o.due ? { dueAt: o.due } : {}),
      ...(o.description ? { description: text(o.description) } : {}),
    });
    return { id: r.ticketId, key: r.key };
  };

  const login = await mk(ada, eng, 'Fix login redirect loop', {
    stage: 'In progress',
    priority: 'High',
    assignees: [grace],
    due: now + 2 * DAY,
    description: 'After signing in with an email link, some people land back on /login.',
  });
  const oauth = await mk(grace, eng, 'Rotate OAuth signing key', {
    stage: 'To do',
    priority: 'Medium',
    assignees: [ada],
  });
  const perf = await mk(ada, eng, 'Board loads slowly with 2k cards', {
    stage: 'Review',
    priority: 'Urgent',
    assignees: [ada],
    due: now - DAY,
  });
  await mk(ada, eng, 'Dark mode for the ticket drawer', { stage: 'Backlog', priority: 'Low' });
  await mk(grace, eng, 'Keyboard shortcut cheatsheet', { stage: 'Backlog' });
  await mk(ada, eng, 'Upgrade to Node 22', { stage: 'Done', assignees: [grace] });
  await mk(grace, eng, 'Flaky e2e on CI', {
    stage: 'To do',
    priority: 'High',
    assignees: [grace],
    due: now + 5 * DAY,
  });
  await mk(ada, eng, 'Document the REST API', { stage: 'In progress', assignees: [ada, grace] });

  const refund = await mk(grace, ops, 'Customer asks for a refund', {
    stage: 'New',
    priority: 'High',
    assignees: [ada],
  });
  await mk(grace, ops, 'Invoice PDF has the wrong address', {
    stage: 'In progress',
    assignees: [grace],
    due: now + DAY,
  });
  await mk(ada, ops, 'Password reset e-mail not arriving', { stage: 'Waiting on customer' });

  await mk(ada, mkt, 'Launch blog post', { stage: 'In progress', due: now + 7 * DAY });
  await mk(ada, mkt, 'Update the pricing page', { stage: 'To do' });

  // ENG-2 blocks ENG-1 (the inverse link is written by the server).
  await call(ada, 'ticketUpdate', {
    boardId: eng.id,
    ticketId: login.id,
    patch: { links: [{ type: 'blockedBy', ticketId: oauth.id }] },
  });
  console.log('seed: tickets on', eng.key, ops.key, mkt.key);

  // ── conversations ─────────────────────────────────────────────────────────
  const post = (who: Person, b: typeof eng, t: { id: string }, body: ReturnType<typeof doc>) =>
    call(who, 'messagePost', {
      boardId: b.id,
      ticketId: t.id,
      body,
      clientId: `seed-${Math.random().toString(36).slice(2, 12)}`,
    });

  await post(
    ada,
    eng,
    login,
    doc([{ mention: grace.uid }, ' can you take a look? I think it is the ?next handling.']),
  );
  await post(
    grace,
    eng,
    login,
    doc([
      'On it. Probably related to ',
      { ref: { ticketId: oauth.id, key: oauth.key } },
      ' — the token refresh races the redirect.',
    ]),
  );
  const decision = await post(
    ada,
    eng,
    login,
    doc(['Decision: keep ?next in sessionStorage, not the URL.']),
  );
  await call(ada, 'messagePin', {
    boardId: eng.id,
    ticketId: login.id,
    messageId: decision.messageId,
    pinned: true,
  });
  await post(
    grace,
    eng,
    perf,
    doc(['Profiled it — virtualising the columns gets us to 60fps. ', { mention: ada.uid }]),
  );
  await post(
    ada,
    ops,
    refund,
    doc(['Refund approved; ', { mention: grace.uid }, ' please reply to the customer.']),
  );

  // ── a shared view ─────────────────────────────────────────────────────────
  await call(ada, 'viewSave', {
    boardId: eng.id,
    view: {
      name: 'Urgent & high',
      type: 'table',
      scope: 'shared',
      position: 10,
      filter: {
        op: 'and',
        children: [
          { field: 'priority', cmp: 'in', value: [priority(eng, 'Urgent'), priority(eng, 'High')] },
        ],
      },
      sort: [{ field: 'due', dir: 'asc' }],
      groupBy: null,
      subGroupBy: null,
      columns: [
        { field: 'key', width: 90 },
        { field: 'title', width: 320 },
        { field: 'priority', width: 110 },
        { field: 'assignee', width: 140 },
        { field: 'due', width: 120 },
      ],
      dateField: null,
      endDateField: null,
      cardFields: [],
      includeStates: ['active'],
    },
  });

  // ── phase 5 (§N): the SAME two tools, with no agent anywhere ──────────────
  // Grace asks Ada a blocking question from the composer, and Ada plans ENG-1
  // with a task list of her own — so a fresh stack shows that questions and
  // task lists belong to the ticket, not to agents.
  await call(grace, 'questionAsk', {
    boardId: eng.id,
    ticketId: login.id,
    title: 'Where should ?next live once we fix this?',
    body: text('Both work; I would rather not guess and redo it.'),
    fields: [
      {
        id: 'where',
        label: 'Keep it in',
        type: 'single',
        required: true,
        options: [
          {
            id: 'session',
            label: 'sessionStorage',
            description: 'invisible in the URL, lost across tabs',
          },
          { id: 'url', label: 'the URL', description: 'shareable, but people paste it around' },
        ],
      },
      { id: 'notes', label: 'Anything I should watch out for?', type: 'text' },
    ],
    allowComment: true,
    to: [ada.uid],
    blocking: true,
  });
  await call(ada, 'tasklistSet', {
    boardId: eng.id,
    ticketId: login.id,
    listId: 'ada-plan',
    title: 'Plan: the redirect loop',
    items: [
      { id: 'repro', title: 'Reproduce it with a fresh account', status: 'done' },
      { id: 'trace', title: 'Trace where ?next is dropped', status: 'doing' },
      { id: 'fix', title: 'Fix it and add a regression test' },
      { id: 'verify', title: 'Verify on staging' },
    ],
  });
  console.log('seed: a person’s question and a person’s task list on', login.key);

  await seedAgent(ada, eng.id);

  console.log(
    `seed: done in ${((Date.now() - t0) / 1000).toFixed(1)}s — sign in as ${ada.email} or ${grace.email}`,
  );
}

/** Fixed id so a re-run finds it (agentCreate accepts a client-chosen id). */
const BUILDER_ID = 'ag_Bu1lderSeed00001';

/**
 * Phase 2 (agents.html §B–E): Ada's agent 'Builder' on ENG as an editor, with a
 * ticket assigned to it (so its inbox has an 'assigned' event) and a Worker
 * token acting as it. Idempotent: each piece is skipped when already there.
 */
async function seedAgent(ada: Person, engId: string): Promise<void> {
  const { db } = admin();
  if (!(await db.doc(`agents/${BUILDER_ID}`).get()).exists) {
    await call(ada, 'agentCreate', {
      agentId: BUILDER_ID,
      name: 'Builder',
      description: 'Implements tickets and reports back with a Markdown summary and an HTML report',
      systemPrompt: [
        '# Builder',
        '',
        'You are **Builder**, an engineering agent on the ENG board.',
        '',
        '1. Call `list_my_tickets` and pick the oldest ticket in *To do*.',
        '2. Move it to *In progress*, do the work, then post a short Markdown summary.',
        '3. Upload a `report.md` and a `report.html`, attach both to your message, and move the ticket to *Review*.',
      ].join('\n'),
    });
  }
  if (!(await db.doc(`boards/${engId}/members/${BUILDER_ID}`).get()).exists) {
    await call(ada, 'boardAgentSet', { boardId: engId, agentId: BUILDER_ID, role: 'editor' });
  }
  const eng = await board(engId);
  const assigned = await db
    .collection(`boards/${engId}/tickets`)
    .where('assigneeUids', 'array-contains', BUILDER_ID)
    .limit(1)
    .get();
  let ticketKey = assigned.docs[0]?.get('key') as string | undefined;
  if (!ticketKey) {
    const { key } = await call(ada, 'ticketCreate', {
      boardId: engId,
      title: 'Write the release notes for 2.0',
      stageId: stage(eng, 'In progress'),
      priorityId: priority(eng, 'Medium'),
      assigneeUids: [BUILDER_ID],
      description: text(
        'Summarise everything that shipped since 1.9. Post the notes as report.md and a styled report.html.',
      ),
    });
    ticketKey = key;
    console.log('seed: agent Builder assigned', key);
  }
  const tokens = await db
    .collection(`users/${ada.uid}/apiKeys`)
    .where('actsAs.id', '==', BUILDER_ID)
    .get();
  if (tokens.docs.every((d) => d.get('revokedAt') != null)) {
    const { key } = await call(ada, 'apiKeyCreate', {
      name: 'orch-eng-builder',
      boardId: engId,
      actsAs: { kind: 'agent', id: BUILDER_ID },
      scopes: [...SCOPE_PRESETS.worker],
    });
    console.log(`seed: Builder's token (shown once): ${key}`);
    // The token is only ever readable here, so this is the one moment the
    // seed can act AS Builder — over the same REST door an orchestrator uses.
    await seedAgentWork(key, ticketKey, ada);
  } else {
    console.log('seed: Builder already has a token — phase-3 demo data left alone');
  }
}

/**
 * Phase 3 (agents.html §L) as an orchestrator would leave it: a plan half
 * ticked off, a blocking question waiting for Ada, and a 'working' beat on the
 * ticket. Every call goes through /v1 with Builder's own token — the seed has
 * no shortcut the real thing does not have.
 *
 * The beat ages like any other: 75 s after seeding, the green dot turns into
 * 🔴 'No signal', which is exactly what a stopped orchestrator looks like.
 */
async function seedAgentWork(token: string, ticketKey: string, ada: Person): Promise<void> {
  const send = async (method: string, path: string, body: unknown) => {
    const r = await http(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status >= 400)
      throw new Error(`seed ${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  // §L2 — the plan, with one item running and one that failed.
  await send('PUT', `/v1/tickets/${ticketKey}/tasklists/plan`, {
    title: 'Plan: release notes 2.0',
    items: [
      { id: 'read', title: 'Read every merged PR since 1.9', status: 'done' },
      { id: 'group', title: 'Group them by area', status: 'done' },
      { id: 'write', title: 'Write the highlights', status: 'doing' },
      {
        id: 'screens',
        title: 'Take the screenshots',
        status: 'failed',
        note: 'The staging deploy is down — retrying after the notes',
      },
      { id: 'publish', title: 'Publish report.md and report.html' },
    ],
  });

  // §L1 — the question the work genuinely depends on, addressed to Ada.
  await send('POST', `/v1/tickets/${ticketKey}/questions`, {
    title: 'How loud should the 2.0 notes be?',
    body_markdown: 'The upgrade needs a config change, so the tone matters.',
    fields: [
      {
        id: 'tone',
        label: 'Tone',
        type: 'single',
        required: true,
        options: [
          {
            id: 'headline',
            label: 'Headline release',
            description: 'lead with the new agent tools',
          },
          { id: 'steady', label: 'Steady update', description: 'features first, migration second' },
          { id: 'quiet', label: 'Quiet note', description: 'a changelog entry, nothing more' },
        ],
      },
      {
        id: 'breaking',
        label: 'Call out the breaking change up top?',
        type: 'boolean',
        required: true,
      },
      {
        id: 'audience',
        label: 'Anyone I should name?',
        type: 'text',
        placeholder: 'e.g. the ops team',
      },
    ],
    allow_comment: true,
    to: [ada.email],
    blocking: true,
  });

  // §L3 — and it says it is working.
  await send('POST', '/v1/heartbeat', {
    ticket: ticketKey,
    state: 'working',
    message: 'Writing the highlights (3/5)',
    progress: 0.4,
  });
  console.log(
    `seed: Builder is working on ${ticketKey} — a plan, an open question and a heartbeat`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('seed failed:', e);
    process.exit(1);
  },
);
