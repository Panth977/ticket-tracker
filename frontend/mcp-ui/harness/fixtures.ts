/** Shapes as backend/src/doors/mcpUi.ts returns them. */
const stages = [
  { id: 's1', name: 'Backlog', category: 'todo' },
  { id: 's2', name: 'In progress', category: 'doing' },
  { id: 's3', name: 'Review', category: 'doing' },
  { id: 's4', name: 'Done', category: 'done' },
];
const day = 86_400_000;
const iso = (d: number) => new Date(Date.now() + d * day).toISOString();
const brief = (
  n: number,
  title: string,
  stage: string,
  due: number | null,
  who: string[],
  prio: string | null = null,
) => ({
  key: `ENG-${n}`,
  title,
  board: 'ENG',
  stage,
  state: 'active',
  priority: prio,
  assignees: who,
  due_at: due === null ? null : iso(due),
  updated_at: iso(-1),
  url: `https://example/b/ENG/t/ENG-${n}`,
});
export const tickets = [
  brief(12, 'Login page crashes on Safari 18', 'In progress', -2, ['panth@example.com'], 'High'),
  brief(14, 'Add CSV export to reports', 'Backlog', 5, [], 'Medium'),
  brief(15, 'Rotate webhook secrets monthly', 'Backlog', null, ['priya@example.com']),
  brief(
    17,
    'Kanban: WIP limit per stage',
    'Review',
    1,
    ['panth@example.com', 'priya@example.com'],
    'High',
  ),
  brief(18, 'Dark mode for the inbox', 'Done', null, ['priya@example.com']),
  brief(
    19,
    'Claude connector shows the board in chat',
    'In progress',
    0,
    ['panth@example.com'],
    'Urgent',
  ),
];
const board = {
  id: 'b1',
  key: 'ENG',
  name: 'Engineering',
  url: 'https://example/b/ENG',
  description_md: null,
  stages,
  priorities: [],
  tags: [],
  fields: [],
  archived: false,
  cost: null,
};
const can = { move: true, assign: true, create: true, comment: true };
const person = (id: string, name: string, email: string) => ({
  id,
  kind: 'user',
  name,
  email,
  avatar_url: null,
  icon: null,
});
const panth = person('u1', 'Panth', 'panth@example.com');
const priya = person('u2', 'Priya', 'priya@example.com');
const msg = (id: string, who: typeof panth, body: string, ago: number) => ({
  id,
  ticket_key: 'ENG-19',
  kind: 'comment',
  body_md: body,
  question: null,
  author: { ...who },
  via: 'app',
  via_token: null,
  reply_to: null,
  attachments: [],
  reactions: {},
  pinned: false,
  run: null,
  created_at: iso(-ago),
  edited_at: null,
  deleted: false,
});

export const views = {
  board: () => ({ view: 'board', board, tickets: [...tickets], truncated: false, can }),
  ticket: (key = 'ENG-19') => {
    const b = tickets.find((t) => t.key === key) ?? tickets[5]!;
    const stage = stages.find((s) => s.name === b.stage)!;
    return {
      view: 'ticket',
      board,
      me: 'u1',
      can,
      ticket: {
        id: 't' + key,
        key: b.key,
        url: b.url,
        title: b.title,
        board: { id: 'b1', key: 'ENG', name: 'Engineering' },
        description_md:
          'Render **board**, **ticket** and **my work** views inside the Claude chat.\n\n- inline cards\n- full screen kanban\n- `callServerTool` for every action',
        stage,
        priority: b.priority ? { id: 'p', name: b.priority } : null,
        tags: ['mcp', 'ui'],
        assignees: b.assignees.map((e) => (e.startsWith('panth') ? panth : priya)),
        start_at: null,
        due_at: b.due_at,
        due_all_day: true,
        estimate: null,
        fields: { Effort: 'M' },
        links: [],
        referenced_by: [],
        state: 'active',
        cost: null,
        created_at: iso(-6),
        updated_at: iso(-1),
        watchers: [panth],
        pinned_messages: [],
        files: [],
        messages: [
          msg('m1', priya, 'Tried it on the phone app — the inline card fits nicely.', 1.2),
          msg('m2', panth, 'Next: move tickets right from the card.', 0.3),
        ],
        counts: { messages: 2, files: 0 },
      },
    };
  },
  mywork: () => {
    const mine = tickets.filter((t) => t.assignees.includes('panth@example.com'));
    return {
      view: 'mywork',
      now: new Date().toISOString(),
      tickets: mine,
      overdue: ['ENG-12'],
      can,
    };
  },
};
