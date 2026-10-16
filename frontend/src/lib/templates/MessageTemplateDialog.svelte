<!--
  The composer's 📋 (docs/plan/templates.html §D1): pick one of the board's
  message templates, fill in its form, Send. The template's submit decides:
  'valid' posts its Markdown (with its data kept on the message), 'invalid'
  keeps the form open with its errors.
-->
<script lang="ts">
  import { markdownToDoc } from '@tm/shared/logic/richtext/index';
  import type { TemplateWithId } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { Button, Dialog, Indicator, toast } from '$lib/ui';
  import { getTicketCtx } from '$lib/ticket/context';
  import { sendMessage } from '$lib/ticket/pending.svelte';
  import { boardSources } from './bridge';
  import { memberInfo, ticketInfo } from './info';
  import { checkMessageResult } from './resolve';
  import TemplateForm from './TemplateForm.svelte';

  interface Props {
    open: boolean;
    templates: TemplateWithId[];
    replyTo?: string | null;
    onsent?: () => void;
  }
  let { open = $bindable(false), templates, replyTo = null, onsent }: Props = $props();

  const t = getTicketCtx();
  let picked = $state<string | null>(null);
  let form: TemplateForm | undefined = $state();
  let busy = $state(false);
  let errMsg = $state('');
  let ready = $state(false);

  $effect(() => {
    if (open) {
      errMsg = '';
      if (!picked || !templates.some((x) => x.id === picked))
        picked = templates.length === 1 ? templates[0]!.id : null;
    } else picked = null;
  });
  const tpl = $derived(templates.find((x) => x.id === picked) ?? null);

  const myMember = $derived(t.members.find((m) => m.uid === t.me));
  const me = $derived({
    id: t.me,
    name: auth.profile?.name || myMember?.name || '',
    email: auth.user?.email ?? myMember?.email ?? '',
    role: t.perms.role ?? '',
  });
  const info = $derived(
    ticketInfo(t.ticket, t.board, new Map(t.members.map((m) => [m.uid, memberInfo(m)]))),
  );

  async function send() {
    if (!form || !tpl) return;
    busy = true;
    errMsg = '';
    try {
      const r = await form.submit();
      if (r.error) {
        errMsg = r.line ? `Line ${r.line}: ${r.error}` : r.error;
        return;
      }
      const c = checkMessageResult(r.result);
      if (c.kind === 'broken') {
        errMsg = c.message;
        return;
      }
      if (c.kind === 'invalid') {
        errMsg = c.errMsg;
        form.setErrors(c.errors);
        return;
      }
      form.setErrors({});
      // Mentions written as @email and #KEY refs become the rich nodes the thread draws.
      const emails = new Map(
        t.members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m.uid]),
      );
      // Not reactive state: a lookup for this one send.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const keys = new Map<string, string>();
      try {
        const live = await new Promise<{ key: string; id: string }[]>((resolve) => {
          const off = boardSources(t.boardId, t.me).tickets.subscribe((s) => {
            if (s.loading) return;
            resolve(s.data);
            queueMicrotask(() => off());
          });
        });
        for (const x of live) keys.set(x.key, x.id);
      } catch {
        /* refs stay text */
      }
      let body;
      try {
        body = markdownToDoc(c.value.msg, {
          uidForEmail: (e) => emails.get(e.toLowerCase()),
          agentOnBoard: (id) => t.members.some((m) => m.uid === id),
          ticketIdForKey: (k) => keys.get(k),
        });
      } catch (e) {
        errMsg = e instanceof Error ? e.message : 'The message is too long';
        return;
      }
      sendMessage({
        boardId: t.boardId,
        ticketId: t.ticketId,
        ticketKey: t.ticket.key,
        authorUid: t.me,
        authorName: me.name || 'You',
        body,
        markdown: c.value.msg,
        replyTo,
        attachments: [],
        template: {
          id: tpl.id,
          name: tpl.name,
          ...(c.value.data !== undefined ? { data: c.value.data } : {}),
        },
      });
      open = false;
      onsent?.();
    } catch (e) {
      toast.error('Could not send', e instanceof Error ? e.message : undefined);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title={tpl ? tpl.name : 'Message templates'} size="lg">
  {#if !tpl}
    <ul class="flex flex-col gap-1" aria-label="Message templates">
      {#each templates as x (x.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-2"
            onclick={() => (picked = x.id)}
          >
            <Indicator of={x} seed={x.id} size="md" />
            <span class="min-w-0">
              <span class="block text-sm font-medium">{x.name}</span>
              {#if x.description}<span class="block truncate text-xs text-muted"
                  >{x.description}</span
                >{/if}
            </span>
          </button>
        </li>
      {:else}
        <li class="px-2 py-3 text-sm text-muted">
          This board has no message templates. An admin adds them in Settings › Templates.
        </li>
      {/each}
    </ul>
  {:else}
    {#key tpl.id}
      <TemplateForm
        bind:this={form}
        bind:ready
        template={tpl}
        board={t.board}
        {me}
        ticket={info}
        ticketHref={t.ticketHref}
      />
    {/key}
    {#if errMsg}<p role="alert" class="mt-3 text-sm text-danger">{errMsg}</p>{/if}
  {/if}
  {#snippet footer()}
    {#if tpl && templates.length > 1}
      <Button variant="ghost" class="mr-auto" onclick={() => (picked = null)}>All templates</Button>
    {/if}
    <Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
    {#if tpl}
      <Button variant="primary" loading={busy} disabled={!ready} onclick={send}>Send</Button>
    {/if}
  {/snippet}
</Dialog>
