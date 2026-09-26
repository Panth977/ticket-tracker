<!--
  One board in Account › Notifications › Per board: Everything / Mine /
  Muted, plus (optional) which events and which stages. Your own
  boards/{b}/prefs/{me}, written through boardPrefSet.
-->
<script lang="ts">
  import { ChevronRight } from 'lucide-svelte';
  import { NOTIFY_EVENTS, paths, type Board, type BoardPref, type NotifyEvent } from '@tm/shared';
  import { command } from '$lib/api';
  import { boardPref, type WithId } from '$lib/stores';
  import { Checkbox } from '$lib/ui';
  import { EVENT_LABELS, MODE_OPTIONS } from './notify';

  interface Props {
    board: WithId<Board>;
    uid: string;
  }
  let { board, uid }: Props = $props();

  const prefQ = $derived(boardPref(board.id, uid));
  const mode = $derived($prefQ.data?.mode ?? 'all');
  const events = $derived($prefQ.data?.events ?? null);
  const stageIds = $derived($prefQ.data?.stageIds ?? null);
  let open = $state(false);

  // Invitations are about joining boards, not about this one.
  const BOARD_EVENTS = NOTIFY_EVENTS.filter((e) => e !== 'invited');

  async function set(pref: Partial<Pick<BoardPref, 'mode' | 'events' | 'stageIds'>>) {
    try {
      await command(
        'boardPrefSet',
        { boardId: board.id, pref },
        {
          optimistic: { path: paths.pref(board.id, uid), patch: pref },
          toast: `Could not update ${board.name}`,
        },
      );
    } catch {
      /* rolled back */
    }
  }

  function toggleEvent(e: NotifyEvent, on: boolean) {
    const cur: readonly NotifyEvent[] = events ?? BOARD_EVENTS;
    // boardPrefSet can't clear the field (absent = every event), so 'all ticked' is sent as the full list.
    void set({ events: BOARD_EVENTS.filter((x) => (x === e ? on : cur.includes(x))) });
  }
  function toggleStage(id: string, on: boolean) {
    const all = board.stages.map((s) => s.id);
    const cur = stageIds ?? all;
    void set({ stageIds: all.filter((x) => (x === id ? on : cur.includes(x))) });
  }
  const customised = $derived(
    (events !== null && BOARD_EVENTS.some((e) => !events.includes(e))) ||
      (stageIds !== null && board.stages.some((s) => !stageIds.includes(s.id))),
  );
</script>

<li class="flex flex-col gap-2 px-4 py-3">
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 text-left"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <ChevronRight
        size={14}
        class="shrink-0 text-muted transition-transform {open ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      <span class="size-2.5 shrink-0 rounded-full" style:background={board.color} aria-hidden="true"
      ></span>
      <span class="font-mono text-xs text-muted">{board.key}</span>
      <span class="truncate text-sm font-medium">{board.name}</span>
      {#if customised}<span class="text-xs text-subtle">· customised</span>{/if}
    </button>
    <div
      class="flex rounded-md border border-line p-0.5"
      role="radiogroup"
      aria-label="Notifications for {board.name}"
    >
      {#each MODE_OPTIONS as m (m.value)}
        <button
          type="button"
          role="radio"
          aria-checked={mode === m.value}
          title={m.hint}
          class="rounded px-2.5 py-1 text-xs transition-colors {mode === m.value
            ? 'bg-accent text-accent-fg'
            : 'text-muted hover:text-text'}"
          onclick={() => mode !== m.value && set({ mode: m.value })}
        >
          {m.label}
        </button>
      {/each}
    </div>
  </div>
  {#if open}
    <p class="pl-6 text-xs text-muted">{MODE_OPTIONS.find((m) => m.value === mode)?.hint}</p>
    <div class="grid grid-cols-1 gap-4 pl-6 sm:grid-cols-2">
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1 text-xs font-semibold text-muted uppercase">Events</legend>
        {#each BOARD_EVENTS as e (e)}
          <Checkbox
            checked={events === null || events.includes(e)}
            label={EVENT_LABELS[e].label}
            onchange={(ev) => toggleEvent(e, (ev.currentTarget as HTMLInputElement).checked)}
          />
        {/each}
      </fieldset>
      <fieldset class="flex flex-col gap-1.5">
        <legend class="mb-1 text-xs font-semibold text-muted uppercase">Stage changes into</legend>
        {#each board.stages as s (s.id)}
          <Checkbox
            checked={stageIds === null || stageIds.includes(s.id)}
            label={s.name}
            disabled={events !== null && !events.includes('stage')}
            onchange={(ev) => toggleStage(s.id, (ev.currentTarget as HTMLInputElement).checked)}
          />
        {/each}
      </fieldset>
    </div>
  {/if}
</li>
