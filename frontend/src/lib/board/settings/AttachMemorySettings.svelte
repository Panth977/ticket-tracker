<!--
  Board settings › Memory › Ticket attachments (memory.html §J). A board takes
  no files of its own: a file put on a ticket goes into a memory granted
  `write` to the board. Here an admin picks WHICH memory the attach dialog
  starts on and the PATH TEMPLATE it fills in — variables are chips that
  insert at the cursor, with a live example. One boardAttachMemorySet per
  Save; Clear sets none (the dialog then starts on the first memory, with the
  default template). Everyone else sees it read-only.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    ATTACH_VARS,
    attachTemplateProblem,
    DEFAULT_ATTACH_TEMPLATE,
    memoryGlyph,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedMemories } from '$lib/memoryRefs/owned';
  import { examplePath, isWriteGranted, type BoardMemoryOut } from '$lib/ticket/attach';
  import { loadBoardMemories } from '$lib/ticket/boardMemories';
  import Button from '$lib/ui/Button.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Select from '$lib/ui/Select.svelte';
  import { toast } from '$lib/ui';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const boardId = $derived(s.board.id);
  const saved = $derived(s.board.attachMemory ?? null);

  // ── the memories granted `write` to this board ────────────────────────────
  // My own memories' grants are read live (an admin flipping one above shows
  // here at once); memoryList answers the rest, and is asked again whenever
  // one of my grants changes.
  const ownedQ = $derived(ownedMemories(s.isAdmin ? auth.uid : null));
  const ownGrants = $derived(
    new Map($ownedQ.data.map((m) => [m.id, grantOf(m, { boardId })] as const)),
  );
  const grantSig = $derived([...ownGrants].map(([k, v]) => `${k}:${v}`).join(','));
  let listed = $state<BoardMemoryOut[] | null>(null);
  let failed = $state(false);
  $effect(() => {
    void grantSig;
    const id = boardId;
    loadBoardMemories(id, auth.uid)
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
    saved ? (listed?.find((m) => m.id === saved.memoryId)?.name ?? 'a memory') : null,
  );

  // ── the form: follows the board until edited ─────────────────────────────
  let memoryId = $state<string | null>(null);
  let template = $state(DEFAULT_ATTACH_TEMPLATE);
  let edited = $state(false);
  $effect(() => {
    const v = saved;
    untrack(() => {
      if (edited) return;
      memoryId = v?.memoryId ?? null;
      template = v?.template ?? DEFAULT_ATTACH_TEMPLATE;
    });
  });
  // Nothing saved yet: start on the first memory there is.
  $effect(() => {
    const first = candidates[0]?.id;
    untrack(() => {
      if (!memoryId && first && !saved) memoryId = first;
    });
  });

  const problem = $derived(attachTemplateProblem(template));
  const now = Date.now();
  const example = $derived(examplePath(template, s.board.key, now));
  const dirty = $derived(
    memoryId !== (saved?.memoryId ?? null) ||
      template !== (saved?.template ?? DEFAULT_ATTACH_TEMPLATE),
  );
  const chosenOk = $derived(!!memoryId && candidates.some((m) => m.id === memoryId));

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
    if (!clear && (problem || !chosenOk || !memoryId)) return;
    busy = true;
    try {
      await command(
        'boardAttachMemorySet',
        {
          boardId,
          attachMemory: clear ? null : { memoryId: memoryId!, template: template.trim() },
        },
        { toast: 'Could not save the attachment setting' },
      );
      edited = false;
      if (clear) {
        memoryId = null;
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
  description="A file put on a ticket goes into one of the memories this board may write to, at a path. Pick the memory the attach dialog starts on, and the path it fills in — people can still change both."
>
  <div class="flex flex-col gap-4" data-attach-settings>
    {#if !s.isAdmin}
      <p class="text-sm" data-attach-current>
        {#if saved}
          Files go into <b>{savedName}</b> at <code class="text-xs">/{saved.template}</code>.
        {:else}
          No default is set: the attach dialog starts on the first memory this board may write to.
        {/if}
      </p>
      <p class="text-sm text-muted">Only board admins change this.</p>
    {:else if listed === null && !failed}
      <p class="text-sm text-muted">Loading…</p>
    {:else if failed}
      <p class="text-sm text-danger">Could not load this board's memories.</p>
    {:else if !candidates.length}
      <p class="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted" data-attach-empty>
        Grant a memory <b>Read &amp; write</b> access above, then pick it here.
      </p>
    {:else}
      <Select
        label="Memory"
        value={memoryId}
        onchange={(e) => {
          memoryId = e.currentTarget.value || null;
          edited = true;
        }}
        placeholder="Choose a memory"
        options={candidates.map((m) => ({ value: m.id, label: `${memoryGlyph(m)} ${m.name}` }))}
        data-attach-memory-select
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
        {#if memoryId && !chosenOk}
          <span class="text-sm text-danger"
            >That memory can no longer be written to from this board.</span
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
