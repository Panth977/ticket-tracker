<!--
  One message (app.json › Message), Google Chat style (agents.html § K):
    mine    on the right, an accent bubble, no avatar
    others  on the left, a neutral bubble, avatar + name (+ Agent badge) on
            the first of a group
  The body (rich text or Markdown), its quote, files and reactions sit in /
  under the bubble; the time shows on hover and under the last bubble of a
  group. On hover React · Reply · Pin · ⋯ (Copy link · Edit · Delete). A
  deleted message stays as a tombstone. System lines are small, centred, grey.
  A message with `run` (phase 17, §Y1) is a TURN RECEIPT: one compact row
  instead of a bubble — Turn 3 · review · $1.24 · 12 min — with the author and
  time kept small on its right.

  My messages carry a status mark: 🕓 on its way, ✓ sent, a red ! when it
  failed — clicking a failed bubble offers Resend and Cancel. Attachments
  still uploading show their progress inside the bubble.
-->
<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import {
    Copy,
    CornerUpLeft,
    FileCode2,
    Link2,
    Loader2,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    RotateCw,
    SmilePlus,
    Trash2,
    X,
  } from 'lucide-svelte';
  import { isAgentId, paths, type Attachment, type Message, type RichTextDoc } from '@tm/shared';
  import { docToMarkdown } from '@tm/shared/logic/index';
  import { outbox } from '$lib/api';
  import { AgentBadge } from '$lib/people';
  import { Badge, Button, Menu, Popover, toast, type MenuItem } from '$lib/ui';
  import {
    Collapsible,
    copyText,
    EditorToolbar,
    isEmptyDoc,
    Markdown,
    normalizeDoc,
    plainText,
    RichEditor,
    RichView,
    snippet,
  } from '$lib/editor';
  import { FileGrid, fileViewer, type ViewerFile } from '$lib/files';
  import { routes } from '$lib/layout/routes';
  import { getTicketCtx } from './context';
  import { ticketPickers } from './pickers';
  import type { ThreadItem } from './pending.svelte';
  import { viaLabel } from './activity';
  import { attachmentFiles, fileHref } from './files';
  import QuestionCard from './QuestionCard.svelte';
  import TurnReceipt from '$lib/cost/TurnReceipt.svelte';
  import PersonAvatar from './PersonAvatar.svelte';
  import MessageStatus from './MessageStatus.svelte';
  import { formatFull, formatWhen } from './time';

  interface Props {
    m: ThreadItem;
    /** First of an author group: draw the avatar + name. */
    head: boolean;
    /** Last of an author group: the time goes under it. */
    tail?: boolean;
    quoted?: Pick<Message, 'authorName' | 'body' | 'deletedAt'> | null;
    highlight?: boolean;
    onreply: (id: string) => void;
    onquote?: (id: string) => void;
  }
  let {
    m,
    head,
    tail = true,
    quoted = null,
    highlight = false,
    onreply,
    onquote,
  }: Props = $props();

  const t = getTicketCtx();
  const pick = ticketPickers(t);
  const QUICK = ['👍', '❤️', '😄', '🎉', '👀', '✅'];

  const isPending = $derived(m.pending === true);
  const msg = $derived(m.pending ? null : m);
  const deleted = $derived(!!msg?.deletedAt);
  const mine = $derived(!!t.me && m.authorUid === t.me);
  const doc = $derived<RichTextDoc>(m.pending ? m.body : m.body.doc);
  /** Cards under the message: stored attachments, or the bubble's uploads (not openable yet). */
  const files = $derived<ViewerFile[]>(
    m.pending
      ? m.attachments.map((a) => ({
          id: a.path,
          path: a.path,
          name: a.name,
          size: a.size,
          mime: a.mime,
        }))
      : attachmentFiles(m.attachments as Attachment[], m.id, m.createdAt),
  );
  /** Agents post Markdown (REST / MCP): render it as GFM; app messages render the rich doc. */
  const markdown = $derived(msg?.markdown ?? null);
  const agent = $derived(isAgentId(m.authorUid));
  const via = $derived(msg ? viaLabel(msg.via) : null);
  /** 'via token orch-eng-builder' (agents.html §E): who wrote it through the API. */
  const viaToken = $derived(msg?.viaToken ?? null);
  const reactions = $derived(Object.entries(msg?.reactions ?? {}).filter(([, u]) => u.length));
  const canAct = $derived(!isPending && !deleted && !t.perms.closed);
  const failed = $derived(m.pending === true && m.status === 'failed');
  /** 'sending' | 'sent' | 'failed' — mine only (a stored message of mine is sent). */
  const mark = $derived(
    !mine
      ? null
      : m.pending
        ? m.status === 'failed'
          ? 'failed'
          : m.status === 'sent'
            ? 'sent'
            : 'sending'
        : 'sent',
  );
  /**
   * Phase 3 (§L1): a question message is a FORM CARD, not a bubble body — the
   * card renders in place of the text and takes the pane's width.
   */
  const question = $derived(
    m.pending ? (m.question ?? null) : m.kind === 'question' && m.question ? m.question : null,
  );
  /** Wide content (files, code, tables, question forms) may use the pane's width. */
  const wide = $derived(
    !!question ||
      files.length > 0 ||
      (m.pending ? m.uploads.length > 0 : false) ||
      /```|\n\|/.test(markdown ?? ''),
  );
  const time = $derived(
    new Date(m.createdAt).toLocaleTimeString(undefined, {
      timeZone: t.tz,
      hour: 'numeric',
      minute: '2-digit',
    }),
  );

  // ——— a failed bubble: Resend / Cancel
  let failOpen = $state(false);
  let bubbleEl: HTMLElement | null = $state(null);
  function resend() {
    failOpen = false;
    outbox.retry(m.id);
  }
  function discard() {
    failOpen = false;
    outbox.cancel(m.id);
  }

  // ——— reactions (optimistic)
  let pickerOpen = $state(false);
  let pickerAnchor: HTMLButtonElement | null = $state(null);
  const at = $derived(`${routes.ticket(t.ticket.key)}?m=${m.id}`);
  const mpath = () => paths.message(t.boardId, t.ticketId, m.id);

  function react(emoji: string) {
    pickerOpen = false;
    if (!msg || !t.perms.comment) return;
    const had = (msg.reactions?.[emoji] ?? []).includes(t.me);
    const next = had
      ? (msg.reactions[emoji] ?? []).filter((u) => u !== t.me)
      : [...(msg.reactions?.[emoji] ?? []), t.me];
    outbox.queue(
      'messageReact',
      { boardId: t.boardId, ticketId: t.ticketId, messageId: msg.id, emoji, on: !had },
      {
        kind: 'ticket',
        label: `react ${emoji}`,
        openTo: at,
        optimistic: { path: mpath(), patch: { [`reactions.${emoji}`]: next } },
      },
    );
  }

  // ——— pin / delete / copy
  function pin(on: boolean) {
    if (!msg) return;
    outbox.queue(
      'messagePin',
      { boardId: t.boardId, ticketId: t.ticketId, messageId: msg.id, pinned: on },
      {
        kind: 'ticket',
        label: on ? 'pin the message' : 'unpin the message',
        openTo: at,
        optimistic: {
          path: mpath(),
          patch: { pinnedAt: on ? Date.now() : null, pinnedBy: on ? t.me : null },
        },
      },
    );
  }
  function remove() {
    if (!msg || !confirm('Delete this message? It will show as deleted to everyone.')) return;
    outbox.queue(
      'messageEdit',
      { boardId: t.boardId, ticketId: t.ticketId, messageId: msg.id, delete: true },
      {
        kind: 'ticket',
        label: 'delete the message',
        openTo: at,
        optimistic: { path: mpath(), patch: { deletedAt: Date.now() } },
      },
    );
  }
  async function copyLink() {
    if (!msg) return;
    const url = new URL(routes.ticket(t.ticket.key), location.origin);
    url.searchParams.set('m', msg.id);
    if (await copyText(url.toString())) toast.success('Link copied');
    else toast.info(url.toString());
  }
  /** The message as Markdown: its source when it was posted as Markdown, else the doc serialised the way the API returns it. */
  function asMarkdown(): string {
    if (markdown != null) return markdown;
    return docToMarkdown(doc, {
      personOf: (uid) => {
        const x = t.members.find((mm) => mm.uid === uid);
        return x ? { name: x.name, email: x.email || null } : undefined;
      },
      keyOf: () => undefined,
    });
  }
  async function copyMarkdown() {
    if (await copyText(asMarkdown())) toast.success('Copied as Markdown');
    else toast.error('Could not copy');
  }

  // ——— edit (author only)
  let editing = $state(false);
  let draft = $state<RichTextDoc | null>(null);
  let editor = $state<Editor | null>(null);
  function saveEdit() {
    if (!msg || !draft) return true;
    if (isEmptyDoc(draft)) {
      toast.error('A message cannot be empty', 'Delete it instead.');
      return true;
    }
    const body = normalizeDoc(draft);
    outbox.queue(
      'messageEdit',
      { boardId: t.boardId, ticketId: t.ticketId, messageId: msg.id, body },
      {
        kind: 'ticket',
        label: 'save your edit',
        openTo: at,
        // An edit in the app editor replaces a Markdown source (MessageSchema.markdown).
        optimistic: {
          path: mpath(),
          patch: { 'body.doc': body, markdown: null, editedAt: Date.now() },
        },
      },
    );
    editing = false;
    return true;
  }

  const isAdmin = $derived(t.perms.role === 'admin');
  const menu = $derived.by<MenuItem[]>(() => {
    const items: MenuItem[] = [
      { label: 'Copy as Markdown', icon: FileCode2, onSelect: copyMarkdown },
      { label: 'Copy link', icon: Link2, onSelect: copyLink },
    ];
    if (t.perms.comment)
      items.unshift({ label: 'Reply', icon: CornerUpLeft, onSelect: () => onreply(m.id) });
    if (onquote)
      items.unshift({ label: 'Quote in reply', icon: Copy, onSelect: () => onquote(m.id) });
    if (t.perms.pin)
      items.push({
        label: msg?.pinnedAt ? 'Unpin' : 'Pin',
        icon: msg?.pinnedAt ? PinOff : Pin,
        onSelect: () => pin(!msg?.pinnedAt),
      });
    // A question is edited by answering or cancelling it, never as text.
    if (mine && t.perms.comment && !question)
      items.push({
        label: 'Edit',
        icon: Pencil,
        onSelect: () => ((draft = doc), (editing = true)),
      });
    if ((mine && t.perms.comment) || isAdmin)
      items.push({
        label: 'Delete',
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: remove,
      });
    return items;
  });
</script>

{#if msg?.run && !deleted}
  <!-- §Y1: the receipt row. The Markdown body says the same thing in words for search / e-mail. -->
  <div
    id="msg-{m.id}"
    class="tm-rise-in px-4 pt-2 transition-colors duration-500 {highlight
      ? 'bg-accent-soft/60'
      : ''}"
  >
    <TurnReceipt
      run={msg.run}
      authorName={m.authorName}
      {time}
      timeTitle={formatFull(m.createdAt, t.tz)}
    />
  </div>
{:else if msg?.kind === 'system'}
  <div
    id="msg-{m.id}"
    class="flex items-center justify-center gap-2 px-5 py-1 text-xs text-subtle {highlight
      ? 'bg-accent-soft'
      : ''}"
  >
    <RichView
      {doc}
      ticketHref={t.ticketHref}
      class="text-center text-xs text-subtle [&_p]:inline"
    />
    <time class="shrink-0" title={formatFull(m.createdAt, t.tz)}>· {time}</time>
  </div>
{:else}
  <article
    id="msg-{m.id}"
    aria-label="Message from {mine ? 'you' : m.authorName}"
    class="tm-rise-in group relative flex items-start gap-2 px-4 transition-colors duration-500 {head
      ? 'mt-2.5'
      : 'mt-0.5'}
      {mine ? 'flex-row-reverse' : ''} {highlight ? 'bg-accent-soft/60' : ''}"
  >
    {#if !mine}
      <div class="w-8 shrink-0 pt-0.5">
        {#if head}
          {#if m.authorUid}<PersonAvatar uid={m.authorUid} size={32} />{:else}
            <span
              class="grid size-8 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-muted"
              >{m.authorName.slice(0, 1).toUpperCase()}</span
            >
          {/if}
        {/if}
      </div>
    {/if}

    <div
      class="flex min-w-0 flex-col {mine ? 'items-end' : 'items-start'} {wide || editing
        ? 'w-full max-w-full'
        : 'max-w-[min(85%,44rem)]'}"
    >
      {#if head && (!mine || via || viaToken)}
        <div
          class="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 px-1 {mine ? 'justify-end' : ''}"
        >
          {#if !mine}
            <span class="text-xs font-semibold">{m.authorName}</span>
            {#if agent}<AgentBadge />{/if}
          {/if}
          {#if via}<Badge>{via}</Badge>{/if}
          {#if viaToken}<span
              class="text-xs text-subtle"
              title="Written through the API with this token"
              >via token <span class="font-mono">{viaToken}</span></span
            >{/if}
        </div>
      {/if}

      <div
        class="flex max-w-full items-end gap-1.5 {mine ? 'flex-row-reverse' : ''} {wide || editing
          ? 'w-full'
          : ''}"
      >
        <!-- The bubble. A failed one is a button-like target: Resend / Cancel. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          bind:this={bubbleEl}
          onclick={(e) => {
            if (failed && !(e.target as HTMLElement).closest('a,button')) failOpen = !failOpen;
          }}
          class="relative min-w-0 rounded-2xl px-3 py-1.5 text-sm {wide || editing ? 'w-full' : ''}
            {mine
            ? 'bg-accent-soft [&_.from-surface]:from-accent-soft'
            : 'bg-surface-2 [&_.from-surface]:from-surface-2'}
            {mine ? (tail ? 'rounded-br-md' : '') : tail ? 'rounded-bl-md' : ''}
            {failed ? 'cursor-pointer ring-1 ring-danger/70' : ''} {m.pending &&
          !failed &&
          m.status !== 'sent'
            ? 'opacity-80'
            : ''}"
        >
          {#if quoted || (m.replyTo && !quoted)}
            <button
              type="button"
              onclick={() => m.replyTo && t.showMessage(m.replyTo)}
              class="mt-0.5 mb-1 block max-w-full rounded border-l-2 border-line-strong bg-surface/60 px-2 py-0.5 text-left text-xs text-muted hover:border-accent"
            >
              {#if quoted}
                <span class="font-medium">{quoted.authorName}</span>
                {quoted.deletedAt
                  ? 'This message was deleted'
                  : snippet(plainText(quoted.body.doc, pick.nameOf), 120)}
              {:else}Replying to an earlier message{/if}
            </button>
          {/if}

          {#if deleted}
            <p class="text-sm text-subtle italic">This message was deleted</p>
          {:else if question}
            <QuestionCard messageId={m.id} {question} askedBy={m.authorUid} pending={isPending} />
          {:else if editing}
            <div class="my-1 rounded-lg border border-accent bg-surface">
              <EditorToolbar {editor} class="border-b border-line px-1 py-0.5" />
              <RichEditor
                value={draft}
                bind:editor
                autofocus
                label="Edit message"
                class="max-h-80 overflow-y-auto px-3 py-2 text-sm"
                options={{
                  people: pick.people,
                  tickets: pick.tickets,
                  nameOf: pick.nameOf,
                  onSubmit: () => (void saveEdit(), true),
                  onEscape: () => ((editing = false), true),
                }}
                onchange={(d) => (draft = d)}
              />
              <div class="flex justify-end gap-2 border-t border-line px-2 py-1">
                <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
                <Button size="sm" variant="primary" onclick={saveEdit}>Save</Button>
              </div>
            </div>
          {:else if markdown != null || !isEmptyDoc(doc)}
            <Collapsible maxLines={40}>
              {#if markdown != null}
                <Markdown source={markdown} ticketHref={t.ticketHref} breaks class="text-sm" />
              {:else}
                <RichView {doc} ticketHref={t.ticketHref} class="text-sm" />
              {/if}
            </Collapsible>
          {/if}

          {#if files.length && !deleted}
            <FileGrid
              class="my-1 max-w-3xl"
              {files}
              disabled={isPending}
              onopen={(f) => fileViewer.open(f, files)}
              hrefFor={isPending ? undefined : fileHref(t)}
            />
          {/if}

          {#if m.pending && m.uploads.length}
            <ul class="my-1 flex flex-col gap-1" aria-label="Uploading">
              {#each m.uploads as u (u.id)}
                <li
                  class="relative flex items-center gap-2 overflow-hidden rounded-md border px-2 py-1 text-xs
                  {u.status === 'error' ? 'border-danger text-danger' : 'border-line bg-surface'}"
                >
                  {#if u.status === 'uploading'}<Loader2
                      size={13}
                      class="shrink-0 animate-spin text-muted"
                    />{/if}
                  <span class="min-w-0 flex-1 truncate">{u.name}</span>
                  <span class="shrink-0 tabular-nums {u.status === 'error' ? '' : 'text-muted'}">
                    {u.status === 'error'
                      ? (u.error ?? 'Failed')
                      : `${Math.round(u.progress * 100)}%`}
                  </span>
                  {#if u.status === 'uploading'}
                    <span
                      class="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-200"
                      style="width:{u.progress * 100}%"
                    ></span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if !tail && !isPending}
          <time
            class="mb-1 shrink-0 text-[10px] text-subtle opacity-0 transition-opacity group-hover:opacity-100"
            title={formatFull(m.createdAt, t.tz)}>{time}</time
          >
        {/if}
      </div>

      {#if reactions.length && !deleted}
        <div class="mt-1 flex flex-wrap gap-1 {mine ? 'justify-end' : ''}">
          {#each reactions as [emoji, uids] (emoji)}
            {@const on = uids.includes(t.me)}
            <button
              type="button"
              onclick={() => react(emoji)}
              disabled={!t.perms.comment}
              title={uids
                .map((u) => t.members.find((x) => x.uid === u)?.name ?? 'Someone')
                .join(', ')}
              aria-pressed={on}
              class="tm-press inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs
                {on
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-surface hover:bg-surface-2'}"
            >
              <span>{emoji}</span><span>{uids.length}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if tail || isPending}
        <div class="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-subtle">
          {#if failed}
            <button
              type="button"
              class="font-medium text-danger hover:underline"
              onclick={() => (failOpen = !failOpen)}>Not sent — tap to retry</button
            >
          {:else}
            <time title={formatFull(m.createdAt, t.tz)}>{formatWhen(m.createdAt, t.tz)}</time>
            {#if msg?.editedAt}<span title={formatFull(msg.editedAt, t.tz)}>· edited</span>{/if}
          {/if}
          {#if mark}<MessageStatus {mark} error={m.pending ? m.error : undefined} />{/if}
        </div>
      {/if}
    </div>

    {#if failed}
      <Popover
        bind:open={failOpen}
        anchor={bubbleEl}
        placement={mine ? 'top-end' : 'top-start'}
        role="menu"
        label="Message not sent"
        class="tm-pop min-w-40 py-1"
      >
        {#if m.pending && m.error}<p class="max-w-64 px-3 py-1 text-xs text-muted">
            {m.error}
          </p>{/if}
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm hover:bg-surface-2"
          onclick={resend}
        >
          <RotateCw size={14} class="text-muted" /> Resend
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-danger hover:bg-surface-2"
          onclick={discard}
        >
          <X size={14} /> Cancel
        </button>
      </Popover>
    {/if}

    {#if canAct && !editing}
      <!-- On the side the message is on: over the bubble's top-right for mine, top-left
           (just past the avatar column) for everyone else's. Anchored to the row, which
           is full width, so the side has to be chosen — not simply the far edge. -->
      <div
        class="tm-pop absolute -top-3 z-[3] hidden items-center rounded-md border border-line bg-surface shadow-pop group-hover:flex group-focus-within:flex {mine
          ? 'right-4'
          : 'left-14'}"
      >
        {#if t.perms.comment}
          <button
            bind:this={pickerAnchor}
            type="button"
            class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Add reaction"
            title="React"
            onclick={() => (pickerOpen = !pickerOpen)}><SmilePlus size={15} /></button
          >
          <button
            type="button"
            class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text"
            aria-label="Reply"
            title="Reply"
            onclick={() => onreply(m.id)}><CornerUpLeft size={15} /></button
          >
        {/if}
        {#if t.perms.pin}
          <button
            type="button"
            class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text"
            aria-label={msg?.pinnedAt ? 'Unpin' : 'Pin'}
            title={msg?.pinnedAt ? 'Unpin' : 'Pin'}
            onclick={() => pin(!msg?.pinnedAt)}
          >
            {#if msg?.pinnedAt}<PinOff size={15} />{:else}<Pin size={15} />{/if}
          </button>
        {/if}
        <Menu items={menu} placement="bottom-end">
          {#snippet trigger(props)}
            <button
              type="button"
              {...props}
              class="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-text"
              aria-label="More"><MoreHorizontal size={15} /></button
            >
          {/snippet}
        </Menu>
      </div>
      <Popover
        bind:open={pickerOpen}
        anchor={pickerAnchor}
        placement="bottom-end"
        label="Reactions"
        class="tm-pop flex gap-0.5 p-1"
      >
        {#each QUICK as e (e)}
          <button
            type="button"
            class="rounded p-1 text-lg transition-transform hover:scale-110 hover:bg-surface-2"
            aria-label="React {e}"
            onclick={() => react(e)}>{e}</button
          >
        {/each}
      </Popover>
    {/if}
  </article>
{/if}
