<!--
  The composer (app.json › Composer): TipTap on THE shared schema.
    @  people on this board (name / email, with picture)
    #  ticket search (Typesense, or the dev fallback)
    /  slash commands at the start of a line: /assign /unassign /me /due /stage /priority /watch /ask /agg
  Σ / /agg opens 'Add to a total' (aggregates.html) when the board has active aggregate fields.
  Paste, drop or 📎 files → the attach dialog asks which memory and at what
  path (memory.html §J: a ticket's files live in a memory granted `write` to
  the board); they upload with progress and go out as memoryUploads on send.
  🧠 attaches files from a memory granted to this board BY REFERENCE
  (memory.html §E): nothing is uploaded, the ticket points at the file.
  The draft (text, reply target, finished uploads) is kept per ticket in
  IndexedDB. ⌘↵ sends; the message shows at once as a bubble and goes out
  through the outbox (agents.html § K): the composer clears on send and is
  never disabled while anything is in flight — not even uploads, which carry
  on inside the sent bubble.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { Brain, Loader2, Paperclip, Send, X } from 'lucide-svelte';
  import { KIND_ICON, kindOf } from '$lib/files';
  import { matchOption } from '@tm/shared/logic/index';
  import { parseDue } from '@tm/shared/logic/time';
  import {
    MAX_ATTACHMENTS_PER_CALL,
    MEMORY_REFS_MAX,
    parseMemoryRefPath,
    type RichTextDoc,
    type TicketPatch,
  } from '@tm/shared';
  import { outbox } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, IconButton, Kbd, toast } from '$lib/ui';
  import {
    draftKey,
    drafts,
    EditorToolbar,
    extractSlash,
    formatBytes,
    isEmptyDoc,
    RichEditor,
    startUpload,
    type DraftAttachment,
    type SlashAction,
    type UploadItem,
  } from '$lib/editor';
  import { getTicketCtx, updateTicket } from './context';
  import { ticketPickers } from './pickers';
  import { relayUpload, sendMessage } from './pending.svelte';
  import { typingSignal } from './presence';
  import AskDialog from './AskDialog.svelte';
  import AggDialog from './AggDialog.svelte';
  import { activeAggFields } from '$lib/aggregates/fields';
  import MemoryPicker from '$lib/memoryRefs/MemoryPicker.svelte';
  import { newFileId, objectPathFor } from '$lib/memory/upload.svelte';
  import AttachDialog from './AttachDialog.svelte';
  import { mergePicks, pickAttachment, type MemoryPick } from '$lib/memoryRefs/pick';

  interface Props {
    replyTo?: string | null;
    /** Author + snippet of the message being replied to. */
    quoted?: { authorName: string; text: string } | null;
    onsent?: () => void;
  }
  let { replyTo = $bindable(null), quoted = null, onsent }: Props = $props();

  const t = getTicketCtx();
  const pick = ticketPickers(t);
  // The ticket id is fixed for this composer's lifetime (the drawer re-mounts per ticket).
  const ticketId = t.ticketId;
  const boardId = t.boardId;

  let editor = $state<Editor | null>(null);
  let doc = $state<RichTextDoc | null>(null);
  let resetKey = $state(0);
  let uploads = $state<UploadItem[]>([]);
  // Not reactive state: cancel handles are only looked up, never rendered.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const cancels = new Map<string, () => void>();
  let fileInput: HTMLInputElement | undefined = $state();
  /** A file is being dragged over the composer (enter/leave fire per child, hence the depth). */
  let dragging = $state(false);
  let dragDepth = 0;
  let loaded = $state(false);
  /** Phase 5 (§N1): the question builder — the ❓ toolbar button and /ask. */
  let askOpen = $state(false);
  /** aggregates.html: 'Add to a total' — the Σ toolbar button and /agg. */
  let aggOpen = $state(false);
  const canAgg = $derived(t.perms.comment && activeAggFields(t.board).length > 0);
  /** memory.html §E: files picked from a memory, sent as memoryRefs. */
  let memoryPicks = $state<MemoryPick[]>([]);
  let memoryOpen = $state(false);
  /** memory.html §J: files waiting for the attach dialog's memory + paths. */
  let attachFiles = $state<File[]>([]);
  let attachOpen = $state(false);

  const typing = t.me ? typingSignal(boardId, ticketId, t.me) : null;
  onDestroy(() => {
    typing?.stop();
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
  });

  // ——— drafts
  const key = t.me ? draftKey(t.me, ticketId) : null;
  $effect(() => {
    if (!key) {
      loaded = true;
      return;
    }
    void drafts.get(key).then((d) => {
      if (d) {
        doc = d.doc;
        replyTo = d.replyTo;
        // A memory reference in a draft is its virtual path (memory.html §E).
        // Only uploads INTO a memory: an older draft's board upload can't be sent any more.
        uploads = d.attachments
          .filter((a) => !parseMemoryRefPath(a.path) && a.memoryId && a.memoryPath)
          .map((a) => ({
            id: a.path,
            ...a,
            progress: 1,
            status: 'done' as const,
          }));
        memoryPicks = d.attachments.flatMap((a) => {
          const ref = parseMemoryRefPath(a.path);
          return ref
            ? [
                {
                  ...ref,
                  memoryName: 'Memory',
                  name: a.name,
                  path: a.name,
                  mime: a.mime,
                  size: a.size,
                },
              ]
            : [];
        });
        resetKey += 1;
      }
      loaded = true;
    });
  });
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = {
      doc: $state.snapshot(doc),
      replyTo,
      attachments: [
        ...uploads.filter((u) => u.status === 'done').map(toAttachment),
        ...memoryPicks.map(pickAttachment),
      ],
    };
    if (!loaded || !key) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (
        (!snapshot.doc || isEmptyDoc(snapshot.doc)) &&
        !snapshot.attachments.length &&
        !snapshot.replyTo
      )
        void drafts.delete(key);
      else
        void drafts.set(key, {
          doc: snapshot.doc ?? { type: 'doc', content: [] },
          replyTo: snapshot.replyTo,
          attachments: snapshot.attachments,
          savedAt: Date.now(),
        });
    }, 400);
  });

  // ——— uploads
  const toAttachment = (u: UploadItem): DraftAttachment => ({
    path: u.path,
    name: u.name,
    size: u.size,
    mime: u.mime,
    ...(u.memoryId ? { memoryId: u.memoryId } : {}),
    ...(u.memoryPath ? { memoryPath: u.memoryPath } : {}),
  });

  /** Files added (📎, paste, drop): the attach dialog says where they go. */
  function addFiles(files: File[]) {
    if (!t.perms.comment || !files.length) return;
    const room = MAX_ATTACHMENTS_PER_CALL - uploads.length;
    if (files.length > room) {
      toast.error(
        `A message can carry ${MAX_ATTACHMENTS_PER_CALL} files`,
        room > 0 ? `Only the first ${room} were added.` : 'Send these first, then add more.',
      );
      files = files.slice(0, Math.max(0, room));
    }
    if (!files.length) return;
    attachFiles = files;
    attachOpen = true;
  }

  /** The dialog's answer: upload each file into the memory, headed for its path. */
  function uploadInto(memoryId: string, list: { file: File; path: string; label: string }[]) {
    // The chip and the ticket show `label` (the file's name as the person left
    // it); the memory node gets the full path's own name.
    for (const { file: f, path, label: name } of list) {
      const target = {
        path: objectPathFor(memoryId, newFileId(), name),
        metadata: { boardId, originalName: name },
        name,
        memoryId,
        memoryPath: path,
      };
      const { item, cancel } = startUpload(f, target, (next) => {
        // Sent with the upload still going: the bubble shows it now.
        if (relayUpload(next)) return;
        uploads = uploads.map((u) => (u.id === next.id ? { ...next, preview: u.preview } : u));
        if (next.status === 'error') toast.error(`Could not upload ${next.name}`, next.error);
      });
      cancels.set(item.id, cancel);
      uploads = [...uploads, item];
    }
  }
  function removeUpload(u: UploadItem) {
    cancels.get(u.id)?.();
    cancels.delete(u.id);
    if (u.preview) URL.revokeObjectURL(u.preview);
    uploads = uploads.filter((x) => x.id !== u.id);
  }

  // ——— slash commands
  async function runSlash(a: SlashAction): Promise<boolean> {
    // /ask is thread work, like commenting (§N1: 'open to anyone who may comment').
    if (a.cmd === 'ask') {
      if (!t.perms.comment)
        return fail(
          "You can't ask a question on this board",
          'Commenters, editors and admins can.',
        );
      askOpen = true;
      return true;
    }
    if (a.cmd === 'agg') {
      if (!t.perms.comment)
        return fail(
          "You can't add to a total on this board",
          'Commenters, editors and admins can.',
        );
      if (!canAgg)
        return fail(
          'This board has no aggregate fields',
          'An admin adds them in Settings › Aggregates.',
        );
      aggOpen = true;
      return true;
    }
    const needsEdit = !['watch', 'unwatch'].includes(a.cmd);
    if (needsEdit && !(t.perms.edit || (a.cmd === 'stage' && t.perms.comment))) {
      toast.error(
        `You can't use /${a.cmd} on this board`,
        'Only editors and admins change fields.',
      );
      return false;
    }
    let p: TicketPatch | null = null;
    const cur = t.ticket.assigneeUids;
    switch (a.cmd) {
      case 'assign':
      case 'me': {
        const add = a.cmd === 'me' ? [t.me] : a.uids;
        if (!add.length) return fail('Mention who to assign: /assign @name');
        p = { assigneeUids: [...new Set([...cur, ...add])] };
        break;
      }
      case 'unassign':
        if (!a.uids.length) return fail('Mention who to unassign: /unassign @name');
        p = { assigneeUids: cur.filter((u) => !a.uids.includes(u)) };
        break;
      case 'due': {
        if (!a.arg || /^(none|clear|-)$/i.test(a.arg)) {
          p = { dueAt: null };
          break;
        }
        const d = parseDue(a.arg, Date.now(), t.tz);
        if (!d)
          return fail(
            `Couldn't read “${a.arg}” as a date`,
            'Try fri, tomorrow, +3d or 2026-10-01 17:00',
          );
        p = { dueAt: d.at, dueAllDay: d.allDay };
        break;
      }
      case 'stage': {
        const s = matchOption(a.arg, t.board.stages);
        if (!s) return fail(`No stage called “${a.arg}”`);
        if (!t.perms.moveTo(s.id)) return fail(`You can't move tickets to ${s.name}`);
        p = { stageId: s.id };
        break;
      }
      case 'priority': {
        if (/^(none|clear|-)$/i.test(a.arg)) {
          p = { priorityId: null };
          break;
        }
        const o = matchOption(a.arg, t.board.priorities);
        if (!o) return fail(`No priority called “${a.arg}”`);
        p = { priorityId: o.id };
        break;
      }
      case 'watch':
      case 'unwatch':
        outbox.queue(
          'ticketWatch',
          { boardId, ticketId, watching: a.cmd === 'watch' },
          {
            kind: 'ticket',
            label: a.cmd === 'watch' ? 'watch this ticket' : 'stop watching',
            onSuccess: () =>
              toast.success(a.cmd === 'watch' ? 'Watching this ticket' : 'Stopped watching'),
          },
        );
        return true;
    }
    return p ? updateTicket(boardId, ticketId, p, { toast: `/${a.cmd} failed` }) : false;
  }
  function fail(msg: string, detail?: string) {
    toast.error(msg, detail);
    return false;
  }

  // ——— send
  const uploading = $derived(uploads.filter((u) => u.status === 'uploading'));
  const ready = $derived(uploads.filter((u) => u.status === 'done'));
  const canSend = $derived(
    loaded &&
      (!isEmptyDoc(doc) || ready.length > 0 || uploading.length > 0 || memoryPicks.length > 0),
  );

  async function send(): Promise<boolean> {
    const raw = editor ? (editor.getJSON() as RichTextDoc) : doc;
    const memory = $state.snapshot(memoryPicks) as MemoryPick[];
    if (!raw || (isEmptyDoc(raw) && !ready.length && !uploading.length && !memory.length))
      return true;
    const { action, rest } = extractSlash(raw);
    if (action) {
      const ok = await runSlash(action);
      if (!ok) return true;
      if (isEmptyDoc(rest) && !ready.length && !uploading.length && !memory.length) {
        clear();
        return true;
      }
    }
    const inflight = uploading.map((u) => $state.snapshot(u) as UploadItem);
    const attachments = ready.map(toAttachment);
    const reply = replyTo;
    // In-flight uploads now belong to the message: don't cancel them on clear().
    for (const u of inflight) cancels.delete(u.id);
    clear(inflight.map((u) => u.id));
    sendMessage({
      boardId,
      ticketId,
      ticketKey: t.ticket.key,
      authorUid: t.me,
      authorName: auth.profile?.name || auth.user?.displayName || 'You',
      body: rest,
      replyTo: reply,
      attachments,
      uploading: inflight,
      memory,
    });
    onsent?.();
    return true;
  }
  /** Empty the composer. `keep`: uploads handed to a sent message (their previews stay alive). */
  function clear(keep: string[] = []) {
    typing?.stop();
    for (const u of uploads) if (u.preview && !keep.includes(u.id)) URL.revokeObjectURL(u.preview);
    uploads = [];
    memoryPicks = [];
    replyTo = null;
    doc = null;
    editor?.commands.clearContent(true);
    if (key) void drafts.delete(key);
  }

  export function focus() {
    editor?.commands.focus('end');
  }
  $effect(() => {
    if (replyTo) editor?.commands.focus('end');
  });
</script>

{#if t.perms.closed}
  <div class="border-t border-line bg-surface-2 px-5 py-3 text-sm text-muted">
    This ticket is {t.ticket.state} — its thread is closed.
  </div>
{:else if !t.perms.comment}
  <div class="border-t border-line bg-surface-2 px-5 py-3 text-sm text-muted">
    You can read this thread. Commenters, editors and admins can reply.
  </div>
{:else}
  <div
    class="tm-safe-bottom tm-safe-x relative border-t border-line bg-surface px-4 pt-2 [--tm-safe-extra:0.75rem]"
    role="group"
    aria-label="Reply"
    ondragenter={(e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth += 1;
      dragging = true;
    }}
    ondragleave={() => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dragging = false;
    }}
    ondragover={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
    ondrop={(e) => {
      dragDepth = 0;
      dragging = false;
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
    }}
  >
    {#if dragging}
      <div
        class="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/90 text-sm font-medium text-accent"
      >
        <span class="flex items-center gap-2"
          ><Paperclip size={16} /> Drop files to attach them</span
        >
      </div>
    {/if}
    {#if replyTo}
      <div
        class="mb-2 flex items-start gap-2 rounded-md border-l-2 border-accent bg-surface-2 px-2 py-1 text-xs"
      >
        <span class="min-w-0 flex-1 text-muted">
          Replying to <span class="font-medium text-text">{quoted?.authorName ?? 'a message'}</span>
          {#if quoted?.text}<span class="block truncate">{quoted.text}</span>{/if}
        </span>
        <button
          type="button"
          aria-label="Cancel reply"
          class="rounded p-0.5 text-muted hover:text-text"
          onclick={() => (replyTo = null)}><X size={13} /></button
        >
      </div>
    {/if}

    <div class="rounded-lg border border-line bg-surface focus-within:border-accent">
      <EditorToolbar
        {editor}
        onattach={() => fileInput?.click()}
        onask={() => (askOpen = true)}
        onmemory={() => (memoryOpen = true)}
        onagg={canAgg ? () => (aggOpen = true) : undefined}
        class="border-b border-line px-1.5 py-1"
      />
      <RichEditor
        value={doc}
        {resetKey}
        bind:editor
        label="Write a reply"
        class="max-h-72 overflow-y-auto px-3 py-2 text-sm"
        options={{
          placeholder: 'Write a reply — @ to mention, # to link, / for commands',
          people: pick.people,
          tickets: pick.tickets,
          nameOf: pick.nameOf,
          slash: true,
          onSubmit: () => (void send(), true),
        }}
        onchange={(d) => {
          doc = d;
          typing?.ping();
        }}
        onblur={() => typing?.stop()}
        onfiles={addFiles}
      />

      {#if uploads.length || memoryPicks.length}
        <ul class="flex flex-wrap gap-2 border-t border-line px-2 py-2" aria-label="Attachments">
          {#each memoryPicks as p (p.memoryId + p.nodeId)}
            <li
              class="relative flex max-w-56 items-center gap-2 overflow-hidden rounded-md border border-line px-2 py-1.5"
              data-memory-pick={p.name}
            >
              <Brain size={16} class="shrink-0 text-accent" aria-label="From memory" />
              <span class="flex min-w-0 flex-col leading-tight">
                <span class="truncate text-xs">{p.name}</span>
                <span class="truncate text-[11px] text-muted"
                  >{p.memoryName} · {formatBytes(p.size)}</span
                >
              </span>
              <IconButton
                icon={X}
                label="Remove {p.name}"
                size="sm"
                onclick={() =>
                  (memoryPicks = memoryPicks.filter(
                    (x) => !(x.memoryId === p.memoryId && x.nodeId === p.nodeId),
                  ))}
              />
            </li>
          {/each}
          {#each uploads as u (u.id)}
            <li
              class="relative flex max-w-56 items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5
              {u.status === 'error' ? 'border-danger' : 'border-line'}"
            >
              {#if u.preview}
                <img src={u.preview} alt="" class="size-8 shrink-0 rounded object-cover" />
              {:else if u.status === 'uploading'}
                <Loader2 size={16} class="shrink-0 animate-spin text-muted" />
              {:else}
                {@const KindIcon = KIND_ICON[kindOf(u)]}
                <KindIcon size={16} class="shrink-0 text-muted" />
              {/if}
              <span class="flex min-w-0 flex-col leading-tight">
                <span class="truncate text-xs">{u.name}</span>
                <span class="text-[11px] {u.status === 'error' ? 'text-danger' : 'text-muted'}">
                  {u.status === 'error'
                    ? (u.error ?? 'Failed')
                    : u.status === 'uploading'
                      ? `${Math.round(u.progress * 100)}%`
                      : formatBytes(u.size)}
                </span>
              </span>
              <IconButton
                icon={X}
                label="Remove {u.name}"
                size="sm"
                onclick={() => removeUpload(u)}
              />
              {#if u.status === 'uploading'}
                <span
                  class="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width]"
                  style="width:{u.progress * 100}%"
                ></span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="flex items-center gap-2 px-2 pb-1.5">
        <span class="hidden text-xs text-subtle sm:inline"
          ><Kbd keys="mod+enter" /> to send{#if uploads.length}
            · {uploads.length}
            {uploads.length === 1 ? 'file' : 'files'}{#if uploading.length}, uploading…{/if}{/if}</span
        >
        <span class="flex-1"></span>
        <!-- Never disabled while something is sending; an empty composer just has nothing to send. -->
        <Button
          size="sm"
          variant="primary"
          icon={Send}
          disabled={!canSend}
          onclick={send}
          class="tm-press">Send</Button
        >
      </div>
    </div>
    <AskDialog bind:open={askOpen} onasked={() => onsent?.()} />
    {#if canAgg}<AggDialog bind:open={aggOpen} onsent={() => onsent?.()} />{/if}
    <AttachDialog
      bind:open={attachOpen}
      {boardId}
      boardKey={t.board.key}
      ticketKey={t.ticket.key}
      attachMemory={t.board.attachMemory}
      isAdmin={t.perms.role === 'admin'}
      files={attachFiles}
      onattach={(a) => uploadInto(a.memoryId, a.list)}
    />
    <MemoryPicker
      bind:open={memoryOpen}
      {boardId}
      room={MEMORY_REFS_MAX - memoryPicks.length}
      onpick={(picks) => (memoryPicks = mergePicks(memoryPicks, picks, MEMORY_REFS_MAX))}
    />
    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="hidden"
      onchange={(e) => {
        addFiles([...(e.currentTarget.files ?? [])]);
        e.currentTarget.value = '';
      }}
    />
  </div>
{/if}
