<!--
  People & roles (app.json components › People & roles). "The board is
  everything: the only way onto it is an invite from here, and the role is
  per person."
    Invite by email · Role ▾ · Message
    Picture · Name · Email · Role on this board · Stage grant · ⋯ Remove
    Pending invites — revoke or resend
    Agents (agents.html §C): Add agent (admins, their own agents) · agent rows
    with role / stage grant / remove (./people/*)
  Rendered by the sidebar's People page AND Board settings › People & roles,
  so it loads what it needs from `boardId` alone. Admins change roles and
  grants (boardAccessSet); admins — or editors when the board allows it — invite.
-->
<script lang="ts">
  import { Clock, Mail, MoreHorizontal, RotateCw, Send, UserMinus, X } from 'lucide-svelte';
  import {
    BOARD_ROLES,
    paths,
    type Board,
    type BoardMember,
    type BoardRole,
    type Invite,
    type StageGrant,
  } from '@tm/shared';
  import { page } from '$app/state';
  import { command, outbox } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { docStore, queryStore } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import { isAgentId, noteBoardMembers, Principal } from '$lib/people';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import StageGrantEditor from './StageGrantEditor.svelte';
  import AddAgentCard from './people/AddAgentCard.svelte';
  import AgentMembers from './people/AgentMembers.svelte';

  interface Props {
    boardId: string;
  }
  let { boardId }: Props = $props();

  const boardStore = $derived(docStore<Board>(paths.board(boardId)));
  const board = $derived($boardStore.data);
  const me = $derived(auth.uid ?? '');
  const myRole = $derived<BoardRole | null>(board?.access[me] ?? null);
  const isAdmin = $derived(myRole === 'admin');
  const archived = $derived(board?.archivedAt != null);
  const canInvite = $derived(
    !archived && (isAdmin || (myRole === 'editor' && !!board?.settings.editorsCanInvite)),
  );

  const membersStore = $derived(queryStore<BoardMember>({ path: paths.members(boardId) }));
  const ROLE_ORDER: Record<BoardRole, number> = { admin: 0, editor: 1, commenter: 2, viewer: 3 };
  const isAgent = (m: BoardMember) => m.kind === 'agent' || isAgentId(m.uid);
  // Tell person() where this board's agents live (their profiles are private to the owner).
  $effect(() => noteBoardMembers(boardId, $membersStore.data));
  const agents = $derived(
    $membersStore.data.filter(isAgent).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const members = $derived(
    $membersStore.data
      .filter((m) => !isAgent(m))
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          (a.name || a.email).localeCompare(b.name || b.email),
      ),
  );
  // Rules let only admins list a board's invites.
  const invitesStore = $derived(
    queryStore<Invite>(
      isAdmin
        ? {
            path: paths.invites(),
            where: [
              ['boardId', '==', boardId],
              ['status', '==', 'pending'],
            ],
            orderBy: [['createdAt', 'desc']],
          }
        : null,
    ),
  );
  const admins = $derived(Object.values(board?.access ?? {}).filter((r) => r === 'admin').length);

  const ROLE_LABEL: Record<BoardRole, string> = {
    admin: 'Admin',
    editor: 'Editor',
    commenter: 'Commenter',
    viewer: 'Viewer',
  };
  const ROLE_HINT: Record<BoardRole, string> = {
    admin: 'Settings, people and everything editors can do',
    editor: 'Create and edit every ticket, move anywhere',
    commenter: 'Read, post in threads, move within a stage grant',
    viewer: 'Read only',
  };

  // ── invite ──
  let emails = $state('');
  let role = $state<BoardRole>('editor');
  let message = $state('');
  let inviting = $state(false);
  const parsed = $derived([
    ...new Set(
      emails
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]);
  const bad = $derived(parsed.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)));
  const inviteRoles = $derived(isAdmin ? BOARD_ROLES : BOARD_ROLES.filter((r) => r !== 'admin'));

  async function invite(e: SubmitEvent) {
    e.preventDefault();
    if (!parsed.length || bad.length || parsed.length > 50) return;
    inviting = true;
    try {
      const res = await command(
        'inviteCreate',
        {
          boardId,
          invites: parsed.map((email) => ({ email, role })),
          ...(message.trim() ? { message: message.trim() } : {}),
        },
        { toast: 'Could not send the invites' },
      );
      const n = res.invited.length;
      toast.success(
        n ? `Invited ${n === 1 ? res.invited[0] : `${n} people`}` : 'Nobody new to invite',
        res.alreadyOnBoard.length
          ? `Already on the board: ${res.alreadyOnBoard.join(', ')}`
          : undefined,
      );
      emails = '';
      message = '';
    } catch {
      /* toasted */
    } finally {
      inviting = false;
    }
  }

  // ── access: through the outbox — the list changes at once, the write follows ──
  function access(
    input: {
      people?: Record<string, BoardRole | null>;
      stageGrants?: Record<string, StageGrant | null>;
    },
    what: string,
    m: BoardMember,
    patch: Record<string, unknown> | null,
    done?: string,
  ) {
    outbox.queue(
      'boardAccessSet',
      { boardId, ...input },
      {
        kind: 'settings:people',
        label: what,
        openTo: page.url.pathname,
        optimistic: { path: paths.member(boardId, m.uid), patch },
        ...(done ? { onSuccess: () => toast.success(done) } : {}),
      },
    );
  }
  function setRole(m: BoardMember, r: BoardRole) {
    if (r === m.role) return;
    // A commenter's grant means nothing for other roles: drop it with the change.
    const grants = m.role === 'commenter' && m.stageGrant ? { stageGrants: { [m.uid]: null } } : {};
    const who = m.name || m.email;
    access(
      { people: { [m.uid]: r }, ...grants },
      `change ${who}'s role`,
      m,
      { role: r, ...(grants.stageGrants ? { stageGrant: null } : {}) },
      `${who} is now ${ROLE_LABEL[r].toLowerCase()}`,
    );
  }
  function setGrant(m: BoardMember, g: StageGrant | null) {
    access({ stageGrants: { [m.uid]: g } }, `change ${m.name || m.email}'s stage grant`, m, {
      stageGrant: g,
    });
  }
  function remove(m: BoardMember) {
    if (
      !confirm(
        `Remove ${m.name || m.email} from ${board?.name ?? 'this board'}? They lose access at once.`,
      )
    )
      return;
    access(
      { people: { [m.uid]: null } },
      `remove ${m.name || m.email}`,
      m,
      null,
      `Removed ${m.name || m.email}`,
    );
  }
  const lastAdmin = (m: BoardMember) => m.role === 'admin' && admins <= 1;

  // ── pending invites ──
  let working = $state<string | null>(null);
  async function revoke(inv: Invite & { id: string }, resend: boolean) {
    working = inv.id;
    try {
      await command(
        'inviteRevoke',
        { inviteId: inv.id, ...(resend ? { resend: true as const } : {}) },
        { toast: resend ? 'Could not resend' : 'Could not revoke' },
      );
      toast.success(resend ? `Sent again to ${inv.email}` : `Revoked the invite for ${inv.email}`);
    } catch {
      /* toasted */
    } finally {
      working = null;
    }
  }
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms);
</script>

{#if $boardStore.loading || $membersStore.loading}
  <Skeleton lines={4} />
{:else if !board}
  <p class="text-sm text-muted">Board not found.</p>
{:else}
  <div class="flex flex-col gap-6">
    {#if canInvite}
      <form
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
        onsubmit={invite}
        aria-label="Invite people"
      >
        <div>
          <h3 class="flex items-center gap-1.5 font-medium"><Mail size={15} /> Invite by email</h3>
          <p class="text-sm text-muted">
            They get an email link; the invite also waits in their inbox for 14 days.
          </p>
        </div>
        <div class="flex flex-wrap items-start gap-2">
          <label class="min-w-64 flex-1">
            <span class="sr-only">Email addresses</span>
            <textarea
              bind:value={emails}
              rows={parsed.length > 1 ? 3 : 1}
              placeholder="ana@example.com, raj@example.com"
              class="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            ></textarea>
          </label>
          <label>
            <span class="sr-only">Role</span>
            <select
              bind:value={role}
              class="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              title={ROLE_HINT[role]}
            >
              {#each inviteRoles as r (r)}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            icon={Send}
            loading={inviting}
            disabled={!parsed.length || bad.length > 0 || parsed.length > 50}
          >
            Invite{parsed.length > 1 ? ` ${parsed.length}` : ''}
          </Button>
        </div>
        <p class="text-xs text-muted">{ROLE_LABEL[role]}: {ROLE_HINT[role]}.</p>
        {#if bad.length}<p class="text-xs text-danger">Not an email: {bad.join(', ')}</p>{/if}
        {#if parsed.length > 50}<p class="text-xs text-danger">At most 50 at a time.</p>{/if}
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-muted">Message (optional)</span>
          <textarea
            bind:value={message}
            rows="2"
            maxlength="1000"
            placeholder="Join us to track the launch."
            class="rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent"
          ></textarea>
        </label>
      </form>
    {/if}

    <div class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="w-full min-w-[40rem] text-sm">
        <thead class="border-b border-line text-left text-xs text-muted">
          <tr>
            <th class="px-4 py-2 font-medium">Person</th>
            <th class="px-2 py-2 font-medium">Role on this board</th>
            <th class="px-2 py-2 font-medium">Stage grant</th>
            <th class="w-10 px-2 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          {#each members as m (m.uid)}
            {@const self = m.uid === me}
            <tr>
              <td class="px-4 py-2"
                ><Principal id={m.uid} layout="stacked" suffix={self ? '(you)' : undefined} /></td
              >
              <td class="px-2 py-2">
                {#if isAdmin && !archived}
                  <select
                    class="h-8 rounded-md border border-line bg-surface px-1.5"
                    value={m.role}
                    aria-label="Role of {m.name || m.email}"
                    disabled={lastAdmin(m)}
                    title={lastAdmin(m) ? 'The board needs at least one admin' : ROLE_HINT[m.role]}
                    onchange={(e) => {
                      const r = e.currentTarget.value as BoardRole;
                      e.currentTarget.value = m.role; // the live member doc decides what shows
                      void setRole(m, r);
                    }}
                  >
                    {#each BOARD_ROLES as r (r)}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
                  </select>
                {:else}
                  <span title={ROLE_HINT[m.role]}>{ROLE_LABEL[m.role]}</span>
                {/if}
              </td>
              <td class="px-2 py-2">
                {#if m.role === 'commenter'}
                  {#if isAdmin && !archived}
                    <StageGrantEditor
                      stages={board.stages}
                      grant={board.stageGrants[m.uid] ?? m.stageGrant}
                      onchange={(g) => setGrant(m, g)}
                    />
                  {:else}
                    {@const g = board.stageGrants[m.uid] ?? m.stageGrant}
                    <span class="text-xs text-muted">
                      {g?.stages.length
                        ? g.stages
                            .map((id) => board.stages.find((s) => s.id === id)?.name ?? '?')
                            .join(', ')
                        : 'None'}
                      {#if g?.assignedOnly}
                        · only their tickets{/if}
                    </span>
                  {/if}
                {:else}
                  <span class="text-xs text-subtle">—</span>
                {/if}
              </td>
              <td class="px-2 py-2">
                {#if isAdmin && !self && !archived}
                  <Menu
                    placement="bottom-end"
                    items={[
                      {
                        label: 'Remove from board',
                        icon: UserMinus,
                        danger: true,
                        disabled: lastAdmin(m),
                        onSelect: () => remove(m),
                      },
                    ]}
                  >
                    {#snippet trigger(p)}
                      <button
                        type="button"
                        {...p}
                        class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                        aria-label="More for {m.name || m.email}"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    {/snippet}
                  </Menu>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if isAdmin && !archived}
      <AddAgentCard {board} />
    {/if}
    <AgentMembers {board} {agents} {isAdmin} />

    {#if isAdmin}
      <section class="flex flex-col gap-2" aria-label="Pending invites">
        <h3 class="flex items-center gap-1.5 font-medium">
          <Clock size={15} /> Pending invites
          <span class="text-sm font-normal text-muted">{$invitesStore.data.length}</span>
        </h3>
        {#if $invitesStore.error}
          <p class="text-sm text-danger">Couldn't load invites: {$invitesStore.error.message}</p>
        {:else if $invitesStore.data.length === 0}
          <p class="text-sm text-muted">No one is waiting to join.</p>
        {:else}
          <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {#each $invitesStore.data as inv (inv.id)}
              {@const expired = inv.expiresAt < Date.now()}
              <li class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span class="min-w-0 flex-1">
                  <span class="font-medium">{inv.email}</span>
                  <span class="text-muted">
                    · {ROLE_LABEL[inv.role]} · invited by {inv.invitedByName} · {expired
                      ? 'expired'
                      : `expires ${fmt(inv.expiresAt)}`}</span
                  >
                </span>
                {#if !archived}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={RotateCw}
                    loading={working === inv.id}
                    onclick={() => revoke(inv, true)}>Resend</Button
                  >
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    disabled={working === inv.id}
                    onclick={() => revoke(inv, false)}>Revoke</Button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
{/if}
