<!--
  Harness for QuestionCard: it reads the open ticket from context, so a test
  sets one up around it. Everything here is the smallest shape getTicketCtx()
  and the card actually touch.
-->
<script lang="ts">
  import type { Question } from '@tm/shared';
  import { setTicketCtx, type TicketCtx } from './context';
  import type { TicketPerms } from './perms';
  import QuestionCard from './QuestionCard.svelte';

  interface Props {
    question: Question;
    me?: string;
    askedBy?: string | null;
    preview?: boolean;
    role?: TicketPerms['role'];
  }
  let {
    question,
    me = 'u1',
    askedBy = null,
    preview = false,
    role = 'commenter',
  }: Props = $props();
  // The harness is built once per render(), so the context it sets is a snapshot.
  // svelte-ignore state_referenced_locally
  const role0 = role;
  // svelte-ignore state_referenced_locally
  const me0 = me;

  const board = {
    id: 'b1',
    access: { u1: 'commenter', u2: 'commenter', ad: 'admin' },
    stageGrants: {},
    settings: { allowDelete: false },
    stages: [],
    priorities: [],
    tags: [],
  };
  const perms: TicketPerms = {
    role: role0,
    edit: role0 === 'editor' || role0 === 'admin',
    comment: role0 !== 'viewer',
    pin: false,
    state: false,
    restore: false,
    delete: false,
    moveTo: () => false,
    closed: false,
  };

  setTicketCtx({
    boardId: 'b1',
    ticketId: 't1',
    ticket: { id: 't1', key: 'ENG-1' },
    board,
    members: [
      { uid: 'u1', name: 'Ada' },
      { uid: 'u2', name: 'Priya' },
    ],
    perms,
    me: me0,
    tz: 'UTC',
    ticketHref: (k: string) => `/t/${k}`,
    showMessage: () => {},
    readSince: null,
  } as unknown as TicketCtx);
</script>

<QuestionCard messageId="m1" {question} {askedBy} {preview} />
