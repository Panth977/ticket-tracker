<!--
  Board settings › Integrations.
  WEBHOOKS (admins): https endpoints signed with a per-hook secret (shown once
  on create / rotate). Saving sends a 'ping' and says whether it landed. 20
  failures in a row switch a hook off. 'Recent deliveries' shows what was sent
  and what came back (deliveries/, kept 30 days).
  APPS: GitHub (link repos, move on merge) and Slack (post to a channel),
  connected through the provider's OAuth — installConnect, board admin only.
-->
<script lang="ts">
  import {
    Check,
    Copy,
    GitBranch,
    Hash,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    Webhook as WebhookIcon,
  } from 'lucide-svelte';
  import {
    paths,
    WEBHOOK_EVENTS,
    WEBHOOK_MAX_FAILURES,
    type Integration,
    type IntegrationProvider,
    type Webhook,
    type WebhookDelivery,
    type WebhookEvent,
  } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { postJson } from '$lib/account/rawApi';
  import { queryStore, type WithId } from '$lib/stores';
  import Badge from '$lib/ui/Badge.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const hooks = $derived(
    queryStore<Webhook>(
      s.isAdmin ? { path: paths.webhooks(s.board.id), orderBy: [['createdAt', 'asc']] } : null,
    ),
  );
  const installs = $derived(queryStore<Integration>({ path: paths.integrations(s.board.id) }));
  const byProvider = $derived(
    new Map($installs.data.filter((i) => i.status !== 'removed').map((i) => [i.provider, i])),
  );

  // ── webhook editor ──
  let editOpen = $state(false);
  let editing = $state<WithId<Webhook> | null>(null);
  let url = $state('');
  let events = $state<WebhookEvent[]>([]);
  let active = $state(true);
  let busy = $state(false);
  let secret = $state<{ hookUrl: string; value: string } | null>(null);
  let copied = $state(false);
  const urlOk = $derived(/^https:\/\/[^\s/]+/.test(url.trim()));

  const EVENT_LABEL: Record<WebhookEvent, string> = {
    'ticket.created': 'Ticket created',
    'ticket.updated': 'Ticket updated',
    'ticket.moved': 'Ticket moved to another stage',
    'ticket.state': 'Ticket archived or restored',
    'ticket.deleted': 'Ticket deleted',
    'message.created': 'New message',
    'message.pinned': 'Message pinned',
    'board.updated': 'Board settings changed',
    'member.joined': 'Someone joined',
  };

  function openEditor(h: WithId<Webhook> | null) {
    editing = h;
    url = h?.url ?? 'https://';
    events = h ? [...h.events] : ['ticket.created', 'ticket.updated', 'ticket.moved'];
    active = h?.active ?? true;
    editOpen = true;
  }
  async function upsert(
    input: {
      webhookId?: string;
      url: string;
      events: WebhookEvent[];
      active?: boolean;
      rotateSecret?: true;
    },
    done: string,
  ) {
    busy = true;
    try {
      const r = await command(
        'webhookUpsert',
        { boardId: s.board.id, ...input },
        { toast: 'Could not save the webhook' },
      );
      if (r.secret) secret = { hookUrl: input.url, value: r.secret };
      if (r.ping && !r.ping.ok)
        toast.error(
          `${done} — but the test ping failed`,
          r.ping.status
            ? `The endpoint answered ${r.ping.status}.`
            : 'The endpoint could not be reached.',
        );
      else toast.success(done, r.ping ? 'Test ping delivered.' : undefined);
      return true;
    } catch {
      return false;
    } finally {
      busy = false;
    }
  }
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!urlOk || !events.length) return;
    const ok = await upsert(
      { ...(editing ? { webhookId: editing.id } : {}), url: url.trim(), events, active },
      editing ? 'Webhook saved' : 'Webhook added',
    );
    if (ok) editOpen = false;
  }
  async function remove(h: WithId<Webhook>) {
    if (!confirm(`Delete the webhook to ${h.url}? Deliveries stop at once.`)) return;
    await command(
      'webhookDelete',
      { boardId: s.board.id, webhookId: h.id },
      { toast: 'Could not delete the webhook' },
    )
      .then(() => toast.success('Webhook deleted'))
      .catch(() => {});
  }
  function toggleEvent(ev: WebhookEvent, on: boolean) {
    events = on ? [...new Set([...events, ev])] : events.filter((x) => x !== ev);
  }

  // ── deliveries (one hook at a time) ──
  let openHook = $state<string | null>(null);
  const deliveries = $derived(
    queryStore<WebhookDelivery>(
      openHook
        ? {
            path: paths.webhookDeliveries(s.board.id, openHook),
            orderBy: [['createdAt', 'desc']],
            limit: 20,
          }
        : null,
    ),
  );
  const when = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  const tone = (st: WebhookDelivery['status']) =>
    st === 'ok' ? 'success' : st === 'pending' ? 'neutral' : 'danger';

  // ── apps ──
  const APPS: {
    provider: IntegrationProvider;
    name: string;
    icon: typeof GitBranch;
    blurb: string;
  }[] = [
    {
      provider: 'github',
      name: 'GitHub',
      icon: GitBranch,
      blurb:
        'Mention ENG-42 in a branch, PR or commit to link it; move the ticket when the PR merges.',
    },
    {
      provider: 'slack',
      name: 'Slack',
      icon: Hash,
      blurb: "Post this board's activity to a channel, and unfurl ticket links.",
    },
  ];
  /** The provider's OAuth dance starts server-side (installConnect: signed state { uid, boardId, nonce }). */
  /**
   * installConnect: a plain link can't carry the Firebase ID token, so POST
   * with it — the api answers the provider's signed authorize URL (state is
   * HMAC-signed: board, admin, expiry) and the browser goes there.
   */
  let connecting = $state<IntegrationProvider | null>(null);
  async function connect(p: IntegrationProvider) {
    connecting = p;
    try {
      const { url } = await postJson<{ url: string }>(`/integrations/${p}/connect`, {
        boardId: s.board.id,
      });
      window.location.assign(url);
    } catch (e) {
      connecting = null;
      toast.error('Could not start connecting', isAppError(e) ? e.message : undefined);
    }
  }
  async function disconnect(p: IntegrationProvider, name: string) {
    if (!confirm(`Disconnect ${name} from this board?`)) return;
    await command(
      'installRemove',
      { boardId: s.board.id, provider: p },
      { toast: `Could not disconnect ${name}` },
    )
      .then(() => toast.success(`${name} disconnected`))
      .catch(() => {});
  }
  const stageName = (id?: string) =>
    id ? (s.board.stages.find((x) => x.id === id)?.name ?? 'a removed stage') : null;
</script>

<Section
  title="Integrations"
  description="Send this board's events to your own systems, or connect the tools your team already uses."
>
  <div class="flex max-w-3xl flex-col gap-8">
    <!-- webhooks -->
    <section class="flex flex-col gap-3" aria-label="Webhooks">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="flex items-center gap-1.5 font-medium"><WebhookIcon size={15} /> Webhooks</h3>
          <p class="text-sm text-muted">
            Signed POSTs (<code>X-TM-Signature</code>) to an https endpoint whenever something
            happens here.
          </p>
        </div>
        {#if s.isAdmin && !s.readOnly}<Button icon={Plus} onclick={() => openEditor(null)}
            >Add webhook</Button
          >{/if}
      </div>

      {#if secret}
        <div
          class="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning-soft p-4 text-sm"
          role="status"
        >
          <strong
            >Signing secret for {secret.hookUrl} — copy it now, it won't be shown again.</strong
          >
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs"
              >{secret.value}</code
            >
            <Button
              size="sm"
              icon={copied ? Check : Copy}
              onclick={() =>
                navigator.clipboard
                  .writeText(secret!.value)
                  .then(() => (copied = true))
                  .catch(() => toast.error('Could not copy'))}>Copy</Button
            >
            <Button size="sm" variant="ghost" onclick={() => ((secret = null), (copied = false))}
              >Done</Button
            >
          </div>
        </div>
      {/if}

      {#if !s.isAdmin}
        <p class="text-sm text-muted">Only board admins can see webhooks.</p>
      {:else if $hooks.data.length === 0}
        <p class="rounded-lg border border-dashed border-line p-5 text-center text-sm text-muted">
          No webhooks yet.
        </p>
      {:else}
        <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
          {#each $hooks.data as h (h.id)}
            {@const dead = h.failures >= WEBHOOK_MAX_FAILURES}
            <li class="flex flex-col gap-2 px-4 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <code class="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</code>
                {#if !h.active}<Badge tone={dead ? 'danger' : 'neutral'}
                    >{dead ? 'Disabled after failures' : 'Paused'}</Badge
                  >
                {:else if h.failures > 0}<Badge tone="warning">{h.failures} failing</Badge>
                {:else}<Badge tone="success">Active</Badge>{/if}
                {#if !s.readOnly}
                  <button
                    type="button"
                    class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                    aria-label="Edit webhook"
                    onclick={() => openEditor(h)}><Pencil size={13} /></button
                  >
                  <button
                    type="button"
                    class="grid size-7 place-items-center rounded text-muted hover:bg-surface-2"
                    aria-label="Rotate secret"
                    title="Rotate secret"
                    disabled={busy}
                    onclick={() =>
                      confirm(
                        'Rotate the signing secret? The old one stops working immediately.',
                      ) &&
                      upsert(
                        { webhookId: h.id, url: h.url, events: h.events, rotateSecret: true },
                        'Secret rotated',
                      )}
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    type="button"
                    class="grid size-7 place-items-center rounded text-muted hover:bg-danger-soft hover:text-danger"
                    aria-label="Delete webhook"
                    onclick={() => remove(h)}><Trash2 size={13} /></button
                  >
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-1 text-xs text-muted">
                {#each h.events as ev (ev)}<span
                    class="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{ev}</span
                  >{/each}
                <button
                  type="button"
                  class="ml-auto text-accent hover:underline"
                  aria-expanded={openHook === h.id}
                  onclick={() => (openHook = openHook === h.id ? null : h.id)}
                  >{openHook === h.id ? 'Hide' : 'Recent'} deliveries</button
                >
              </div>
              {#if openHook === h.id}
                <div class="overflow-x-auto rounded-md border border-line">
                  {#if $deliveries.loading}
                    <p class="p-3 text-xs text-muted">Loading…</p>
                  {:else if $deliveries.data.length === 0}
                    <p class="p-3 text-xs text-muted">Nothing sent in the last 30 days.</p>
                  {:else}
                    <table class="w-full min-w-[34rem] text-xs">
                      <thead class="bg-surface-2 text-left text-muted">
                        <tr
                          ><th class="px-2 py-1 font-medium">When</th><th
                            class="px-2 py-1 font-medium">Event</th
                          ><th class="px-2 py-1 font-medium">Result</th><th
                            class="px-2 py-1 font-medium">Response</th
                          ></tr
                        >
                      </thead>
                      <tbody class="divide-y divide-line">
                        {#each $deliveries.data as d (d.id)}
                          <tr class="align-top">
                            <td class="px-2 py-1 whitespace-nowrap"
                              >{when(d.createdAt)}{#if d.attempt > 1}<span class="text-muted">
                                  · try {d.attempt}</span
                                >{/if}</td
                            >
                            <td class="px-2 py-1 font-mono">{d.event}</td>
                            <td class="px-2 py-1 whitespace-nowrap">
                              <Badge tone={tone(d.status)}
                                >{d.status === 'gave_up' ? 'gave up' : d.status}</Badge
                              >
                              <span class="text-muted"
                                >{d.responseCode ?? '—'} · {Math.round(d.durationMs)} ms</span
                              >
                              {#if d.nextAttemptAt}<div class="text-muted">
                                  retry {when(d.nextAttemptAt)}
                                </div>{/if}
                            </td>
                            <td class="max-w-64 px-2 py-1"
                              ><code class="line-clamp-2 break-all text-muted"
                                >{d.responseSnippet || '—'}</code
                              ></td
                            >
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- apps -->
    <section class="flex flex-col gap-3" aria-label="Apps">
      <h3 class="font-medium">Apps</h3>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {#each APPS as app (app.provider)}
          {@const inst = byProvider.get(app.provider)}
          <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
            <div class="flex items-center gap-2">
              <app.icon size={18} />
              <span class="font-medium">{app.name}</span>
              {#if inst}<span class="ml-auto"
                  ><Badge tone={inst.status === 'active' ? 'success' : 'danger'}
                    >{inst.status === 'active' ? 'Connected' : 'Error'}</Badge
                  ></span
                >{/if}
            </div>
            <p class="text-sm text-muted">{app.blurb}</p>
            {#if inst}
              {#if app.provider === 'github'}
                {#if inst.config.repos?.length}
                  <ul class="flex flex-col gap-1 text-xs">
                    {#each inst.config.repos as r (r.fullName)}
                      <li>
                        <code class="font-mono">{r.fullName}</code
                        >{#if stageName(r.moveOnMerge)}<span class="text-muted">
                            · merged PRs → {stageName(r.moveOnMerge)}</span
                          >{/if}
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <p class="text-xs text-muted">
                    No repositories linked yet — pick them on GitHub's installation page.
                  </p>
                {/if}
              {:else if app.provider === 'slack'}
                <p class="text-xs text-muted">
                  {inst.config.channelId
                    ? `Posting to channel ${inst.config.channelId}`
                    : 'No channel chosen yet.'}
                </p>
              {/if}
              <p class="text-xs text-subtle">
                Connected {new Date(inst.connectedAt).toLocaleDateString()}
              </p>
              {#if s.isAdmin && !s.readOnly}
                <div class="flex gap-2">
                  <Button
                    size="sm"
                    loading={connecting === app.provider}
                    onclick={() => connect(app.provider)}>Reconnect</Button
                  >
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => disconnect(app.provider, app.name)}>Disconnect</Button
                  >
                </div>
              {/if}
            {:else if s.isAdmin && !s.readOnly}
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={connecting === app.provider}
                  onclick={() => connect(app.provider)}>Connect {app.name}</Button
                >
              </div>
            {:else}
              <p class="text-xs text-subtle">Not connected.</p>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  </div>
</Section>

<Dialog
  bind:open={editOpen}
  title={editing ? 'Edit webhook' : 'Add webhook'}
  size="md"
  description="We POST a signed JSON envelope for each event you pick, and send a test ping when you save."
>
  <form id="webhook-form" class="flex flex-col gap-4" onsubmit={submit}>
    <Input
      label="Endpoint URL"
      bind:value={url}
      type="url"
      required
      placeholder="https://example.com/hooks/taskmanager"
      error={url && url !== 'https://' && !urlOk ? 'https only' : null}
      hint="Private and local addresses are refused."
    />
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-sm font-medium">Events</legend>
      <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {#each WEBHOOK_EVENTS as ev (ev)}
          <Checkbox
            label={EVENT_LABEL[ev]}
            checked={events.includes(ev)}
            onchange={(e) => toggleEvent(ev, e.currentTarget.checked)}
          />
        {/each}
      </div>
      {#if !events.length}<span class="text-xs text-danger">Pick at least one event.</span>{/if}
    </fieldset>
    {#if editing}
      <Checkbox
        label="Active"
        description="Paused webhooks keep their settings but receive nothing. Turning one back on resets its failure count."
        checked={active}
        onchange={(e) => (active = e.currentTarget.checked)}
      />
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (editOpen = false)}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="webhook-form"
      loading={busy}
      disabled={!urlOk || !events.length}>{editing ? 'Save' : 'Add webhook'}</Button
    >
  {/snippet}
</Dialog>
