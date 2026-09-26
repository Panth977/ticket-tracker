<!--
  🔔 Mine ▾ — MY notification mode on this board (boards/{b}/prefs/{me}.mode,
  written through boardPrefSet; nobody sets anyone else's). Finer control
  (events, stages) lives in Account › Notifications.
-->
<script lang="ts">
  import { Bell, BellOff, BellRing, Check, ChevronDown } from 'lucide-svelte';
  import { paths, type BoardPref } from '@tm/shared';
  import { outbox } from '$lib/api';
  import Menu from '$lib/ui/Menu.svelte';
  import type { MenuItem } from '$lib/ui/types';
  import { routes } from '$lib/layout/routes';

  interface Props {
    boardId: string;
    uid: string;
    pref: BoardPref | null;
  }
  let { boardId, uid, pref }: Props = $props();

  const MODES = [
    { id: 'all', label: 'All activity', hint: 'Everything on this board', icon: BellRing },
    { id: 'mine', label: 'Mine', hint: "Tickets I'm assigned to, created or watch", icon: Bell },
    {
      id: 'muted',
      label: 'Muted',
      hint: 'Only mentions and tickets I explicitly watch',
      icon: BellOff,
    },
  ] as const;
  const mode = $derived(pref?.mode ?? 'mine');
  const current = $derived(MODES.find((m) => m.id === mode) ?? MODES[1]);

  function set(m: BoardPref['mode']) {
    if (m === mode) return;
    outbox.queue(
      'boardPrefSet',
      { boardId, pref: { mode: m } },
      {
        kind: 'settings',
        label: 'change your notifications',
        optimistic: { path: paths.pref(boardId, uid), patch: { mode: m } },
      },
    );
  }
  const items = $derived<MenuItem[]>([
    ...MODES.map((m) => ({
      label: `${m.label} — ${m.hint}`,
      icon: m.id === mode ? Check : m.icon,
      onSelect: () => set(m.id),
    })),
    {
      label: 'More notification settings…',
      href: routes.account('notifications'),
      separator: true,
    },
  ]);
</script>

<Menu {items} placement="bottom-end" class="w-80">
  {#snippet trigger(p)}
    {@const Icon = current.icon}
    <button
      type="button"
      {...p}
      title="Your notifications for this board"
      class="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-surface-2 hover:text-text"
    >
      <!-- §U: the label folds away on a phone so the bar stays one row; it still names the button. -->
      <Icon size={15} /><span class="sr-only sm:not-sr-only sm:inline">{current.label}</span>
      <ChevronDown size={12} class="hidden sm:block" />
    </button>
  {/snippet}
</Menu>
