<!--
  Account › Notifications (app.json › Notification settings). EVERYTHING
  HERE IS YOUR CHOICE — no board or admin can change it.
    event × channel grid (a channel you haven't set up is greyed out)
    quiet hours · email digest · due-date lead time · commitment reminders
    per board: Everything / Mine / Muted, + which events and stages
    recent deliveries: what was sent where, and why something wasn't
  Every change saves at once (profileUpdate merges channels per event).
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- routes.* already builds resolved app paths */
  import {
    paths,
    type ChannelMatrix,
    type Channel,
    type Delivery,
    type Device,
    type NotifyEvent,
    type UserNotify,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myBoards, queryStore } from '$lib/stores';
  import { Badge, Checkbox, Select, Skeleton } from '$lib/ui';
  import BoardNotifyRow from '../BoardNotifyRow.svelte';
  import { dateTime } from '../format';
  import {
    CHANNEL_LABELS,
    CHANNELS,
    channelSetup,
    columnState,
    deliveryExplanation,
    DELIVERY_STATUS_TONE,
    DIGEST_OPTIONS,
    EVENT_LABELS,
    LEAD_TIMES,
    leadLabel,
    NOTIFY_EVENTS,
    quietHoursSummary,
    SETUP_HINT,
    toggleCell,
    toggleColumn,
  } from '../notify';
  import Panel from '../Panel.svelte';
  import SectionHeader from '../SectionHeader.svelte';

  const uid = $derived(auth.uid);
  const profile = $derived(auth.profile);
  const notify = $derived(profile?.notify);
  const tz = $derived(profile?.timezone);

  const devicesQ = $derived(queryStore<Device>(uid ? { path: paths.devices(uid) } : null));
  const setup = $derived(channelSetup(profile, $devicesQ.data.length));
  const boardsQ = $derived(myBoards(uid));
  const boards = $derived(
    $boardsQ.data.filter((b) => b.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const deliveriesQ = $derived(
    queryStore<Delivery>(
      uid
        ? {
            path: paths.deliveries(),
            where: [['uid', '==', uid]],
            orderBy: [['createdAt', 'desc']],
            limit: 20,
          }
        : null,
    ),
  );

  /** Save part of `notify`, optimistically (dotted keys so siblings are kept). */
  async function save(
    patch: Partial<Omit<UserNotify, 'channels'>> & { channels?: Partial<ChannelMatrix> },
  ) {
    if (!uid) return;
    const overlay: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'channels')
        for (const [e, list] of Object.entries(v as object)) overlay[`notify.channels.${e}`] = list;
      else overlay[`notify.${k}`] = v;
    }
    try {
      await command(
        'profileUpdate',
        { notify: patch },
        {
          optimistic: { path: paths.user(uid), patch: overlay },
          toast: 'Could not save that setting',
        },
      );
    } catch {
      /* rolled back */
    }
  }

  function cell(event: NotifyEvent, channel: Channel, on: boolean) {
    if (!notify) return;
    void save({ channels: { [event]: toggleCell(notify.channels, event, channel, on) } });
  }
  function column(channel: Channel, on: boolean) {
    if (!notify) return;
    void save({ channels: toggleColumn(notify.channels, channel, on) });
  }

  function setQuiet(on: boolean) {
    void save({ quietHours: on ? (notify?.quietHours ?? { start: '22:00', end: '07:00' }) : null });
  }
  function setQuietTime(which: 'start' | 'end', value: string) {
    if (!notify?.quietHours || !/^\d{2}:\d{2}$/.test(value)) return;
    void save({ quietHours: { ...notify.quietHours, [which]: value } });
  }

  const leadOptions = $derived(
    notify && !LEAD_TIMES.some((l) => l.value === notify.dueSoonLeadMinutes)
      ? [
          ...LEAD_TIMES,
          { value: notify.dueSoonLeadMinutes, label: leadLabel(notify.dueSoonLeadMinutes) },
        ]
      : LEAD_TIMES,
  );

  function eventOf(groupKey: string): string {
    const e = groupKey.split(':').pop() as NotifyEvent;
    return EVENT_LABELS[e]?.label ?? groupKey;
  }
</script>

<svelte:head><title>Notifications · TaskManager</title></svelte:head>

<SectionHeader
  title="Notifications"
  description="Everything here is your choice — no board or admin can change it. Changes save as you make them."
/>

{#if !notify}
  <Skeleton height="12rem" class="rounded-xl" />
{:else}
  <div class="flex flex-col gap-6">
    <Panel title="What reaches you where">
      <div class="-mx-5 overflow-x-auto px-5">
        <table class="w-full min-w-[34rem] text-sm">
          <thead>
            <tr class="border-b border-line text-left">
              <th scope="col" class="py-2 pr-3 font-medium">Event</th>
              {#each CHANNELS as c (c)}
                {@const st = columnState(notify.channels, c)}
                <th
                  scope="col"
                  class="w-24 px-2 py-2 text-center font-medium {setup[c] ? '' : 'text-subtle'}"
                >
                  <div class="flex flex-col items-center gap-1">
                    <span>{CHANNEL_LABELS[c]}</span>
                    {#if setup[c]}
                      <input
                        type="checkbox"
                        class="size-3.5 accent-[var(--tm-accent)]"
                        aria-label="All events by {CHANNEL_LABELS[c]}"
                        checked={st === 'all'}
                        indeterminate={st === 'some'}
                        onchange={(e) => column(c, (e.currentTarget as HTMLInputElement).checked)}
                      />
                    {:else}
                      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- routes.* already returns app paths -->
                      <a
                        href={routes.account('channels')}
                        class="text-[11px] font-normal text-accent hover:underline"
                        title={SETUP_HINT[c]}
                      >
                        Set up
                      </a>
                    {/if}
                  </div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each NOTIFY_EVENTS as e (e)}
              <tr class="border-b border-line last:border-0">
                <th scope="row" class="py-2 pr-3 text-left font-normal">
                  <span class="block">{EVENT_LABELS[e].label}</span>
                  <span class="block text-xs text-muted">{EVENT_LABELS[e].hint}</span>
                </th>
                {#each CHANNELS as c (c)}
                  <td class="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      class="size-4 accent-[var(--tm-accent)] disabled:opacity-30"
                      aria-label="{EVENT_LABELS[e].label} by {CHANNEL_LABELS[c]}"
                      title={setup[c] ? undefined : SETUP_HINT[c]}
                      disabled={!setup[c]}
                      checked={setup[c] && (notify.channels[e] ?? []).includes(c)}
                      onchange={(ev) => cell(e, c, (ev.currentTarget as HTMLInputElement).checked)}
                    />
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel title="Timing">
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div class="flex flex-col gap-2">
          <Checkbox
            checked={notify.quietHours !== null}
            label="Quiet hours"
            description="Push and WhatsApp wait until they end. In your time zone ({tz})."
            onchange={(e) => setQuiet((e.currentTarget as HTMLInputElement).checked)}
          />
          {#if notify.quietHours}
            <div class="ml-6 flex items-center gap-2 text-sm">
              <input
                type="time"
                class="h-8 rounded-md border border-line bg-surface px-2"
                aria-label="Quiet hours start"
                value={notify.quietHours.start}
                onchange={(e) => setQuietTime('start', (e.currentTarget as HTMLInputElement).value)}
              />
              to
              <input
                type="time"
                class="h-8 rounded-md border border-line bg-surface px-2"
                aria-label="Quiet hours end"
                value={notify.quietHours.end}
                onchange={(e) => setQuietTime('end', (e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <p class="ml-6 text-xs text-muted">{quietHoursSummary(notify.quietHours)}</p>
            <div class="ml-6">
              <Checkbox
                checked={notify.quietHoursAllowMentions === true}
                label="Let @mentions through"
                description="Someone mentioning you still reaches you during quiet hours."
                onchange={(e) =>
                  void save({
                    quietHoursAllowMentions: (e.currentTarget as HTMLInputElement).checked,
                  })}
              />
            </div>
          {/if}
        </div>
        <Select
          label="Email digest"
          hint="Bundle notification emails instead of one per event."
          options={DIGEST_OPTIONS.map((d) => ({ value: d.value, label: d.label }))}
          value={notify.digest}
          onchange={(e) =>
            save({ digest: (e.currentTarget as HTMLSelectElement).value as UserNotify['digest'] })}
        />
        <Select
          label="Remind me before a due date"
          options={leadOptions.map((l) => ({ value: String(l.value), label: l.label }))}
          value={String(notify.dueSoonLeadMinutes)}
          onchange={(e) =>
            save({ dueSoonLeadMinutes: Number((e.currentTarget as HTMLSelectElement).value) })}
        />
        <Checkbox
          checked={notify.commitmentReminders}
          label="Commitment reminders"
          description="When you say “I’ll do it tomorrow” in a comment, remind me then."
          onchange={(e) =>
            save({ commitmentReminders: (e.currentTarget as HTMLInputElement).checked })}
        />
      </div>
    </Panel>

    <Panel title="Per board" description="How much of each board you hear about.">
      {#if $boardsQ.loading}
        <Skeleton lines={3} />
      {:else if !boards.length}
        <p class="text-sm text-muted">You’re not on any boards yet.</p>
      {:else}
        <ul class="-mx-5 -mb-5 divide-y divide-line border-t border-line">
          {#each boards as b (b.id)}
            <BoardNotifyRow board={b} uid={uid ?? ''} />
          {/each}
        </ul>
      {/if}
    </Panel>

    <Panel
      title="Recent deliveries"
      description="What was sent where — and why something wasn’t. Kept for 30 days."
    >
      {#if $deliveriesQ.loading}
        <Skeleton lines={3} />
      {:else if $deliveriesQ.error}
        <p class="text-sm text-danger">Couldn’t load deliveries.</p>
      {:else if !$deliveriesQ.data.length}
        <p class="text-sm text-muted">Nothing sent outside the app yet.</p>
      {:else}
        <ul class="-mx-5 -mb-5 divide-y divide-line border-t border-line">
          {#each $deliveriesQ.data as d (d.id)}
            {@const why = deliveryExplanation(d)}
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 text-sm">
              <span class="w-20 shrink-0 text-muted capitalize">{d.channel}</span>
              <span class="min-w-0 flex-1 truncate"
                >{eventOf(d.groupKey)}{d.inboxIds.length > 1 ? ` ×${d.inboxIds.length}` : ''}</span
              >
              <Badge tone={DELIVERY_STATUS_TONE[d.status] ?? 'neutral'}>{d.status}</Badge>
              <span class="w-40 shrink-0 text-right text-xs text-subtle"
                >{dateTime(d.createdAt, tz)}</span
              >
              {#if why}<p class="w-full pl-23 text-xs text-muted">{why}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>
  </div>
{/if}
