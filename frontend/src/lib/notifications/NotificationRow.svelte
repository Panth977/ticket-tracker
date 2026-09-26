<!--
  Notification row (app.json): ONE collapsed line —
    (avatar) Priya mentioned you on ENG-42 · 3 more      ENG-42 Fix login redirect   3m
  Used by the Inbox (with actions) and the bell (compact, no actions).
  An 'invited' row renders the Accept / Decline buttons inline (`invite` slot).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    AlarmClock,
    AtSign,
    Bell,
    BotOff,
    CircleAlert,
    CircleHelp,
    Mail,
    MessageSquare,
    MoveRight,
    UserPlus,
  } from 'lucide-svelte';
  import type { NotifyEvent } from '@tm/shared';
  import { person } from '$lib/people/person';
  import Avatar from '$lib/ui/Avatar.svelte';
  import type { IconComponent } from '$lib/ui/types';
  import { rowHeadline, timeAgo, type Group } from './inbox';

  interface Props {
    group: Group;
    now: number;
    selected?: boolean;
    compact?: boolean;
    /** Right-hand extras (hover actions, invite buttons). */
    actions?: Snippet;
    onopen?: () => void;
    class?: string;
  }
  let {
    group,
    now,
    selected = false,
    compact = false,
    actions,
    onopen,
    class: cls = '',
  }: Props = $props();

  const head = $derived(group.head);
  const actor = $derived(person(head.actor));
  const actorName = $derived(head.actor ? ($actor.person?.name ?? null) : null);
  const headline = $derived(rowHeadline(group, actorName ?? (head.actor ? '…' : null)));

  const ICONS: Record<NotifyEvent, IconComponent> = {
    assigned: UserPlus,
    mentioned: AtSign,
    comment: MessageSquare,
    stage: MoveRight,
    updated: Bell,
    created: Bell,
    dueSoon: AlarmClock,
    overdue: CircleAlert,
    state: Bell,
    invited: Mail,
    question: CircleHelp,
    agentSilence: BotOff,
  };
  const Icon = $derived(ICONS[head.event] ?? Bell);
</script>

<div
  role="option"
  tabindex="-1"
  aria-selected={selected}
  data-inbox-row={group.key}
  onclick={() => onopen?.()}
  onkeydown={(e) => e.key === 'Enter' && onopen?.()}
  class="group relative flex cursor-pointer items-center gap-3 border-b border-line px-3 {compact
    ? 'py-2'
    : 'py-2.5'}
    {selected ? 'bg-accent-soft' : 'hover:bg-surface-2'} {cls}"
>
  <span
    class="absolute top-1/2 left-1 size-1.5 -translate-y-1/2 rounded-full {group.unread
      ? 'bg-accent'
      : ''}"
    aria-hidden="true"
  ></span>
  {#if head.actor}
    <Avatar
      src={$actor.person?.avatarUrl}
      icon={$actor.person?.icon}
      name={actorName}
      seed={head.actor}
      size={compact ? 22 : 26}
      decorative
    />
  {:else}
    <span
      class="grid shrink-0 place-items-center rounded-full bg-surface-2 text-muted"
      style="width:{compact ? 22 : 26}px;height:{compact ? 22 : 26}px"
    >
      <Icon size={14} aria-hidden="true" />
    </span>
  {/if}

  <div class="min-w-0 flex-1 {compact ? '' : 'sm:flex sm:items-baseline sm:gap-3'}">
    <p class="truncate text-sm {group.unread ? 'font-medium text-text' : 'text-muted'}">
      {headline}
    </p>
    {#if head.ticketKey || head.ticketTitle}
      <p class="truncate text-xs text-muted {compact ? '' : 'sm:min-w-0 sm:flex-1'}">
        {#if head.ticketKey}<span class="font-mono">{head.ticketKey}</span>{/if}
        {head.ticketTitle ?? ''}
      </p>
    {/if}
  </div>

  {#if actions}
    <div class="flex shrink-0 items-center gap-1">{@render actions()}</div>
  {/if}
  <time
    class="w-10 shrink-0 text-right text-xs text-subtle"
    datetime={new Date(head.createdAt).toISOString()}
  >
    {timeAgo(head.createdAt, now)}
  </time>
</div>
