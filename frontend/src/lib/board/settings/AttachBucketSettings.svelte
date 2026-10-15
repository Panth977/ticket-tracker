<!--
  Board settings › Subscriptions › Ticket attachments (bucket.html §J). A board takes
  no files of its own: a file put on a ticket goes into a bucket granted
  `write` to the board. Here an admin picks WHICH bucket the attach dialog
  starts on and the PATH TEMPLATE it fills in — variables are chips that
  insert at the cursor, with a live example. One boardAttachBucketSet per
  Save; Clear sets none (the dialog then starts on the first bucket, with the
  default template). Everyone else sees it read-only.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    ATTACH_VARS,
    attachTemplateProblem,
    DEFAULT_ATTACH_TEMPLATE,
    BUCKET_DEFAULT_INDICATOR,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedBuckets } from '$lib/bucketRefs/owned';
  import { examplePath, isWriteGranted, type BoardBucketOut } from '$lib/ticket/attach';
  import { loadBoardBuckets } from '$lib/ticket/boardBuckets';
  import Button from '$lib/ui/Button.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Select from '$lib/ui/Select.svelte';
  import { toast } from '$lib/ui';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const boardId = $derived(s.board.id);
  const saved = $derived(s.board.attachBucket ?? null);

  // ── the buckets granted `write` to this board ────────────────────────────
  // My own buckets' grants are read live (an admin flipping one above shows
  // here at once); bucketList answers the rest, and is asked again whenever
  // one of my grants changes.
  const ownedQ = $derived(ownedBuckets(s.isAdmin ? auth.uid : null));
  const ownGrants = $derived(
    new Map($ownedQ.data.map((m) => [m.id, grantOf(m, { boardId })] as const)),
  );
  const grantSig = $derived([...ownGrants].map(([k, v]) => `${k}:${v}`).join(','));
  let listed = $state<BoardBucketOut[] | null>(null);
  let failed = $state(false);
  $effect(() => {
    void grantSig;
    const id = boardId;
    loadBoardBuckets(id, auth.uid)
      .then((all) => {
        listed = all;
        failed = false;
      })
      .catch(() => (failed = true));
  });
  const candidates = $derived(
    (listed ?? []).filter((m) =>
      ownGrants.has(m.id)
        ? ownGrants.get(m.id) === 'write' && !m.archived
        : isWriteGranted(m, saved),
    ),
  );
  const savedName = $derived(
    saved ? (listed?.find((m) => m.id === saved.bucketId)?.name ?? 'a bucket') : null,
  );

  // ── the form: follows the board until edited ─────────────────────────────
  let bucketId = $state<string | null>(null);
  let template = $state(DEFAULT_ATTACH_TEMPLATE);
  let edited = $state(false);
  $effect(() => {
    const v = saved;
    untrack(() => {
      if (edited) return;
      bucketId = v?.bucketId ?? null;
      template = v?.template ?? DEFAULT_ATTACH_TEMPLATE;
    });
  });
  // Nothing saved yet: start on the first bucket there is.
  $effect(() => {
    const first = candidates[0]?.id;
    untrack(() => {
      if (!bucketId && first && !saved) bucketId = first;
    });
  });

  const problem = $derived(attachTemplateProblem(template));
  const now = Date.now();
  const example = $derived(examplePath(template, s.board.key, now));
  const dirty = $derived(
    bucketId !== (saved?.bucketId ?? null) ||
      template !== (saved?.template ?? DEFAULT_ATTACH_TEMPLATE),
  );
  const chosenOk = $derived(!!bucketId && candidates.some((m) => m.id === bucketId));

  let input: HTMLInputElement | null = $state(null);
  /** Put `<v>` where the cursor is (replacing a selection) and keep typing after it. */
  function insertVar(v: string) {
    const text = `<${v}>`;
    const el = input;
    const a = el?.selectionStart ?? template.length;
    const b = el?.selectionEnd ?? a;
    template = template.slice(0, a) + text + template.slice(b);
    edited = true;
    queueMicrotask(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(a + text.length, a + text.length);
    });
  }

  let busy = $state(false);
  async function save(clear = false) {
    if (!clear && (problem || !chosenOk || !bucketId)) return;
    busy = true;
    try {
      await command(
        'boardAttachBucketSet',
        {
          boardId,
          attachBucket: clear ? null : { bucketId: bucketId!, template: template.trim() },
        },
        { toast: 'Could not save the attachment setting' },
      );
      edited = false;
      if (clear) {
        bucketId = null;
        template = DEFAULT_ATTACH_TEMPLATE;
      }
      toast.success(clear ? 'Attachment default cleared' : 'Attachment default saved');
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Section
  title="Ticket attachments"
  description="A file put on a ticket goes into one of the buckets this board may write to, at a path. Pick the bucket the attach dialog starts on, and the path it fills in — people can still change both."
>
  <div class="flex flex-col gap-4" data-attach-settings>
    {#if !s.isAdmin}
      <p class="text-sm" data-attach-current>
        {#if saved}
          Files go into <b>{savedName}</b> at <code class="text-xs">/{saved.template}</code>.
        {:else}
          No default is set: the attach dialog starts on the first bucket this board may write to.
        {/if}
      </p>
      <p class="text-sm text-muted">Only board admins change this.</p>
    {:else if listed === null && !failed}
      <p class="text-sm text-muted">Loading…</p>
    {:else if failed}
      <p class="text-sm text-danger">Could not load this board's buckets.</p>
    {:else if !candidates.length}
      <p class="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted" data-attach-empty>
        Add a bucket above with <b>Write</b>, then pick it here.
      </p>
    {:else}
      <Select
        label="Bucket"
        value={bucketId}
        onchange={(e) => {
          bucketId = e.currentTarget.value || null;
          edited = true;
        }}
        placeholder="Choose a bucket"
        options={candidates.map((m) => ({
          value: m.id,
          label: m.name,
          indicator: { of: m, seed: m.id, fallback: BUCKET_DEFAULT_INDICATOR },
        }))}
        data-attach-bucket-select
      />
      <div class="flex flex-col gap-2">
        <Input
          label="Path"
          bind:value={template}
          bind:ref={input}
          maxlength={512}
          autocomplete="off"
          spellcheck={false}
          error={problem}
          oninput={() => (edited = true)}
          data-attach-template
        />
        <div class="flex flex-wrap items-center gap-1.5" aria-label="Insert a variable">
          {#each ATTACH_VARS as v (v)}
            <button
              type="button"
              class="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted hover:border-accent hover:text-text"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => insertVar(v)}
              data-attach-var={v}>&lt;{v}&gt;</button
            >
          {/each}
        </div>
        <p class="text-xs text-muted">
          &lt;ticketId&gt; the ticket's key · &lt;time&gt; when it was attached (UTC) ·
          &lt;random6&gt; six random characters · &lt;filename&gt; the file's name · &lt;exe&gt; its
          extension
        </p>
        {#if example}
          <p class="text-sm" data-attach-example>
            <span class="text-muted">{s.board.key}-42 · photo.png →</span>
            <code class="text-xs">{example}</code>
          </p>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if bucketId && !chosenOk}
          <span class="text-sm text-danger"
            >That bucket can no longer be written to from this board.</span
          >
        {/if}
        <span class="flex-1"></span>
        {#if saved}
          <Button variant="ghost" disabled={busy} onclick={() => save(true)}>Clear</Button>
        {/if}
        <Button
          variant="primary"
          loading={busy}
          disabled={!dirty || !!problem || !chosenOk}
          onclick={() => save()}>Save</Button
        >
      </div>
    {/if}
  </div>
</Section>
