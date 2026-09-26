<!--
  Harness for Tasklists: the pane reads the open ticket from context and its
  lists from ./data (mocked in the test to a plain store).
-->
<script lang="ts">
  import { setTicketCtx, type TicketCtx } from './context';
  import type { TicketPerms } from './perms';
  import type { BoardRole } from '@tm/shared';
  import Tasklists from './Tasklists.svelte';

  interface Props {
    me?: string;
    role?: BoardRole;
  }
  let { me = 'u1', role = 'editor' }: Props = $props();
  // The harness is built once per render(), so the context it sets is a snapshot.
  // svelte-ignore state_referenced_locally
  const role0 = role;
  // svelte-ignore state_referenced_locally
  const me0 = me;

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
    board: {
      id: 'b1',
      access: { u1: role0, u2: 'commenter' },
      stageGrants: {},
      settings: { allowDelete: false },
    },
    members: [{ uid: 'u1', name: 'Ada' }],
    perms,
    me: me0,
    tz: 'UTC',
    ticketHref: (k: string) => `/t/${k}`,
    showMessage: () => {},
    readSince: null,
  } as unknown as TicketCtx);
</script>

<Tasklists />
