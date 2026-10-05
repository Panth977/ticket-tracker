<!--
  Board settings › Intake: a website's feedback widget (POST /v1/intake with
  the x-tm-intake slug + x-tm-secret headers) and email-to-board. intakes/{slug}
  is server-only, so this reads and writes it through intakeUpsert. The secret
  is shown ONCE — on creation or rotation — and never stored in clear.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Copy, KeyRound, RefreshCw } from 'lucide-svelte';
  import type { IntakeConfig } from '@tm/shared';
  import { command } from '$lib/api';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Skeleton from '$lib/ui/Skeleton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import ChoicePicker from '$lib/views/pickers/ChoicePicker.svelte';
  import Section from './Section.svelte';
  import { stageChoices } from '../stageMark';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  let loading = $state(true);
  let intake = $state<IntakeConfig | null>(null);
  let secret = $state<string | null>(null);
  let busy = $state(false);
  let origins = $state('');
  let defaults = $state<IntakeConfig['defaults']>({});
  let fieldMap = $state<{ key: string; field: string }[]>([]);
  let copied = $state('');

  function load(i: IntakeConfig | null) {
    intake = i;
    origins = i?.allowedOrigins.join('\n') ?? '';
    defaults = { ...(i?.defaults ?? {}) };
    fieldMap = Object.entries(i?.fieldMap ?? {}).map(([key, field]) => ({ key, field }));
  }

  onMount(async () => {
    if (!s.isAdmin) {
      loading = false;
      return;
    }
    try {
      const r = await command(
        'intakeUpsert',
        { boardId: s.board.id },
        { toast: 'Could not load the intake' },
      );
      load(r.intake);
    } catch {
      /* toasted */
    } finally {
      loading = false;
    }
  });

  async function upsert(
    input: Omit<Parameters<typeof command<'intakeUpsert'>>[1], 'boardId'>,
    done: string,
  ) {
    busy = true;
    try {
      const r = await command(
        'intakeUpsert',
        { boardId: s.board.id, ...input },
        { toast: 'Could not save the intake' },
      );
      load(r.intake);
      if (r.secret) secret = r.secret;
      toast.success(done);
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  const originList = $derived(
    origins
      .split(/\s+/)
      .map((o) => o.trim())
      .filter(Boolean),
  );
  const badOrigins = $derived(originList.filter((o) => !/^https?:\/\/[^/\s]+$/.test(o)));
  function saveConfig() {
    if (badOrigins.length) return;
    void upsert(
      {
        allowedOrigins: originList,
        defaults: Object.fromEntries(
          Object.entries(defaults).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)),
        ),
        fieldMap: Object.fromEntries(
          fieldMap.filter((m) => m.key.trim() && m.field).map((m) => [m.key.trim(), m.field]),
        ),
      },
      'Intake saved',
    );
  }
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => copied === what && (copied = ''), 1500);
    } catch {
      toast.error('Could not copy');
    }
  }

  const opts = (xs: { id: string; name: string; color?: string; position: number }[]) =>
    [...xs]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ id: o.id, label: o.name, color: o.color }));
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const snippet = $derived(
    intake
      ? `fetch('${origin}/v1/intake', {\n  method: 'POST',\n  headers: {\n    'content-type': 'application/json',\n    'x-tm-intake': '${intake.slug}',\n    'x-tm-secret': '<secret>',\n  },\n  body: JSON.stringify({ title, description, reporter: { email } }),\n});`
      : '',
  );
</script>

<Section
  title="Intake"
  description="Let people outside the board file tickets — from a feedback widget on your site, or by email. Tickets arrive with the defaults below."
>
  {#if !s.isAdmin}
    <p class="text-sm text-muted">Only board admins can see and change the intake.</p>
  {:else if loading}
    <Skeleton lines={4} />
  {:else if !intake}
    <div
      class="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-dashed border-line p-6"
    >
      <p class="text-sm text-muted">
        This board has no intake yet. Turning it on creates an address and a secret for your widget.
      </p>
      <Button
        variant="primary"
        icon={KeyRound}
        loading={busy}
        disabled={s.readOnly}
        onclick={() => upsert({ enabled: true }, 'Intake turned on')}>Turn on intake</Button
      >
    </div>
  {:else}
    <div class="flex max-w-2xl flex-col gap-5">
      {#if secret}
        <div
          class="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning-soft p-4 text-sm"
          role="status"
        >
          <strong>Copy the secret now — it won't be shown again.</strong>
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs"
              >{secret}</code
            >
            <Button
              size="sm"
              icon={copied === 'secret' ? Check : Copy}
              onclick={() => copy(secret!, 'secret')}>Copy</Button
            >
          </div>
        </div>
      {/if}

      <div class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5">
        <Checkbox
          label="Accept new tickets"
          description="Off = the widget and email address refuse submissions; the setup is kept."
          checked={intake.enabled}
          disabled={busy || s.readOnly}
          onchange={(e) =>
            upsert(
              { enabled: e.currentTarget.checked },
              e.currentTarget.checked ? 'Intake on' : 'Intake paused',
            )}
        />
        <dl class="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
          <dt class="text-muted">Slug</dt>
          <dd><code class="font-mono text-xs">{intake.slug}</code></dd>
          <dt class="text-muted">Email</dt>
          <dd>
            {#if intake.email}<code class="font-mono text-xs">{intake.email}</code>{:else}<span
                class="text-subtle">not set up</span
              >{/if}
          </dd>
          <dt class="text-muted">Secret</dt>
          <dd class="flex items-center gap-2">
            <span class="text-xs text-muted"
              >rotated {new Date(intake.rotatedAt).toLocaleDateString()}</span
            >
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              disabled={busy || s.readOnly}
              onclick={() =>
                confirm('Rotate the secret? The old one stops working immediately.') &&
                upsert({ rotateSecret: true }, 'New secret created')}>Rotate</Button
            >
          </dd>
          <dt class="text-muted">Limits</dt>
          <dd class="text-xs text-muted">
            {intake.limits.perMin}/min · {intake.limits.perHour}/hour · {intake.limits.perDay}/day
          </dd>
        </dl>
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between text-xs text-muted">
            <span>Widget call</span>
            <button
              type="button"
              class="flex items-center gap-1 hover:text-text"
              onclick={() => copy(snippet, 'snippet')}
            >
              {#if copied === 'snippet'}<Check size={12} />{:else}<Copy size={12} />{/if} Copy
            </button>
          </div>
          <pre class="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs">{snippet}</pre>
        </div>
      </div>

      <div class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
        <h3 class="font-medium">New tickets from intake</h3>
        <div class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-[8rem_1fr] sm:items-center">
          <span class="text-muted">Stage</span>
          <ChoicePicker
            items={stageChoices(s.board.stages)}
            selected={defaults.stageId ? [defaults.stageId] : []}
            allowNone
            placeholder="First stage"
            label="Default stage"
            disabled={s.readOnly}
            class="w-fit"
            onchange={(ids) => (defaults = { ...defaults, stageId: ids[0] })}
          />
          <span class="text-muted">Priority</span>
          <ChoicePicker
            items={opts(s.board.priorities)}
            selected={defaults.priorityId ? [defaults.priorityId] : []}
            allowNone
            placeholder="None"
            label="Default priority"
            disabled={s.readOnly}
            class="w-fit"
            onchange={(ids) => (defaults = { ...defaults, priorityId: ids[0] })}
          />
          <span class="text-muted">Tags</span>
          <ChoicePicker
            items={opts(s.board.tags)}
            selected={defaults.tagIds ?? []}
            multi
            placeholder="None"
            label="Default tags"
            disabled={s.readOnly}
            class="w-fit"
            onchange={(ids) => (defaults = { ...defaults, tagIds: ids })}
          />
          <span class="text-muted">Assignees</span>
          <ChoicePicker
            items={s.members.map((m) => ({
              id: m.uid,
              label: m.name,
              uid: m.uid,
              search: m.email,
            }))}
            selected={defaults.assigneeUids ?? []}
            multi
            placeholder="Nobody"
            label="Default assignees"
            disabled={s.readOnly}
            class="w-fit"
            onchange={(ids) => (defaults = { ...defaults, assigneeUids: ids })}
          />
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium">Widget fields → custom fields</span>
          <p class="text-xs text-muted">
            Keys in the submission's <code>meta</code> copied into a custom field (e.g.
            <code>appVersion</code> → Version).
          </p>
          {#each fieldMap as m, i (i)}
            <div class="flex items-center gap-2">
              <input
                class="h-8 w-40 rounded-md border border-line bg-bg px-2 text-sm"
                placeholder="appVersion"
                bind:value={m.key}
                disabled={s.readOnly}
                aria-label="Widget key"
              />
              <span class="text-subtle">→</span>
              <select
                class="h-8 rounded-md border border-line bg-surface px-2 text-sm"
                bind:value={m.field}
                disabled={s.readOnly}
                aria-label="Custom field"
              >
                <option value="">Choose a field…</option>
                {#each s.board.fields.filter((f) => !f.archived) as f (f.id)}<option value={f.id}
                    >{f.name}</option
                  >{/each}
              </select>
              <button
                type="button"
                class="text-xs text-muted hover:text-danger"
                disabled={s.readOnly}
                onclick={() => (fieldMap = fieldMap.filter((_, j) => j !== i))}>Remove</button
              >
            </div>
          {/each}
          {#if !s.readOnly && s.board.fields.some((f) => !f.archived)}
            <button
              type="button"
              class="self-start text-sm text-accent hover:underline"
              onclick={() => (fieldMap = [...fieldMap, { key: '', field: '' }])}
              >+ Map a field</button
            >
          {/if}
        </div>

        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium">Allowed origins</span>
          <textarea
            bind:value={origins}
            rows="3"
            disabled={s.readOnly}
            placeholder="https://example.com"
            class="rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
          ></textarea>
          <span class="text-xs {badOrigins.length ? 'text-danger' : 'text-muted'}">
            {badOrigins.length
              ? `Not an origin: ${badOrigins.join(', ')}`
              : 'One per line. Browsers on other sites are refused; empty = any site.'}
          </span>
        </label>
        {#if !s.readOnly}
          <div>
            <Button
              variant="primary"
              loading={busy}
              disabled={badOrigins.length > 0}
              onclick={saveConfig}>Save intake</Button
            >
          </div>
        {/if}
      </div>
    </div>
  {/if}
</Section>
