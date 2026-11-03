<!--
  The field panel: STAGE (built in — the app's own, with its grants), then the
  BOARD SCRIPT's fields (docs/plan/board-script.html: fieldRender draws them,
  onFieldChange turns an edit into a ticket patch), then Links. A board with no
  saved script runs the one generated from its settings (boards from before
  scripts) or the default (Assignees). Every write is a ticketUpdate with an
  optimistic overlay; the server checks it as always. A commenter sees the
  stages their grant allows and nothing else editable.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import { indicatorColor, indicatorOf, type ScriptControl, type TicketPatch } from '@tm/shared';
  import { auth } from '$lib/firebase/auth.svelte';
  import { toast } from '$lib/ui';
  import ScriptControls from '$lib/templates/ScriptControls.svelte';
  import {
    acquireScriptHost,
    effectiveBoardScript,
    releaseScriptHost,
    savedScript,
    type BoardScriptHost,
    type ScriptMe,
  } from '$lib/templates/script';
  import { getTicketCtx, updateTicket } from './context';
  import OptionPicker from './fields/OptionPicker.svelte';
  import LinksEditor from './LinksEditor.svelte';

  const t = getTicketCtx();
  const byPos = <X extends { position: number }>(xs: readonly X[]) =>
    [...xs].sort((a, b) => a.position - b.position);

  const CATEGORY: Record<string, string> = {
    backlog: 'Backlog',
    todo: 'To do',
    active: 'In progress',
    done: 'Done',
    cancelled: 'Cancelled',
  };

  const stages = $derived(
    byPos(t.board.stages).map((s) => ({
      id: s.id,
      name: s.name,
      color: indicatorColor(indicatorOf(s, s.id)),
      indicator: indicatorOf(s, s.id),
      hint: s.description ?? null,
      detail: CATEGORY[s.category],
      disabled: s.id !== t.ticket.stageId && !t.perms.moveTo(s.id),
    })),
  );
  const canMove = $derived(stages.some((s) => !s.disabled && s.id !== t.ticket.stageId));
  const people = $derived(
    [...t.members]
      .filter((m) => m.role !== 'viewer' || t.ticket.assigneeUids.includes(m.uid))
      .sort((a, b) => a.name.localeCompare(b.name))
      // Agents are listed with people (agents.html §D); their detail names them as agents.
      .map((m) => ({
        id: m.uid,
        uid: m.uid,
        name: m.name || m.email,
        detail: m.kind === 'agent' ? ['Agent', m.description].filter(Boolean).join(' · ') : m.email,
      })),
  );
  const ed = $derived(t.perms.edit);

  const patch = (p: TicketPatch) => updateTicket(t.boardId, t.ticketId, p, { key: t.ticket.key });

  // ── the board script ──
  const saved = savedScript(t.boardId);
  const code = $derived($saved.loading ? null : effectiveBoardScript(t.board, $saved.data).code);
  const me = $derived<ScriptMe>({
    id: t.me,
    name: auth.profile?.name || t.members.find((m) => m.uid === t.me)?.name || '',
    email: auth.user?.email ?? t.members.find((m) => m.uid === t.me)?.email ?? '',
    role: t.members.find((m) => m.uid === t.me)?.role ?? '',
  });
  let host = $state<BoardScriptHost | null>(null);
  let held: { h: BoardScriptHost; boardId: string; me: ScriptMe } | null = null;
  $effect(() => {
    const c = code;
    const m = me;
    if (c === null) return;
    const h = acquireScriptHost(c, t.board, m);
    const prev = held;
    held = { h, boardId: t.boardId, me: m };
    host = h;
    if (prev) releaseScriptHost(prev.h, prev.boardId, prev.me);
  });
  onDestroy(() => {
    if (held) releaseScriptHost(held.h, held.boardId, held.me);
  });

  let controls = $state<ScriptControl[] | null>(null);
  let problem = $state<string | null>(null);
  let drawSeq = 0;
  $effect(() => {
    const h = host;
    const ticket = t.ticket;
    void ticket.updatedAt;
    if (!h) return;
    const seq = ++drawSeq;
    void h.fields({ ticket }).then((r) => {
      if (seq !== drawSeq) return;
      if (r.error !== undefined) {
        problem = r.line ? `${r.error} (line ${r.line})` : r.error;
        return;
      }
      problem = null;
      controls = r.value;
    });
  });

  async function onFieldChange(c: { id: string; value: unknown; allDay?: boolean }) {
    const h = host;
    if (!h) return;
    const r = await h.change({ ticket: t.ticket, ...c });
    if (r.error !== undefined) {
      toast.error(`Board script: ${r.error}${r.line ? ` (line ${r.line})` : ''}`);
      return;
    }
    if (!r.value) return;
    const p = { ...r.value } as TicketPatch;
    // Dropping an assignee also drops their commitment date.
    if (p.assigneeUids) {
      const gone = t.ticket.assigneeUids.filter(
        (u) => !p.assigneeUids!.includes(u) && t.ticket.commitments?.[u] != null,
      );
      if (gone.length)
        p.commitments = {
          ...Object.fromEntries(gone.map((u) => [u, null])),
          ...(p.commitments ?? {}),
        };
    }
    void patch(p);
  }
</script>

{#snippet row(label: string, body: Snippet, hint?: string)}
  <div
    class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-2 @3xl:grid-cols-1 @3xl:gap-y-0.5"
  >
    <span class="pt-2 text-xs font-medium text-muted @3xl:pt-0" title={hint}>{label}</span>
    <div class="min-w-0">{@render body()}</div>
  </div>
{/snippet}

<div class="flex flex-col gap-2.5 @3xl:gap-3">
  {#snippet stageBody()}
    <OptionPicker
      label="Stage"
      options={stages}
      value={[t.ticket.stageId]}
      disabled={!canMove}
      onchange={(ids) => ids[0] && void patch({ stageId: ids[0] })}
    />
  {/snippet}
  {@render row('Stage', stageBody)}

  <ScriptControls
    controls={controls ?? []}
    {people}
    tz={t.tz}
    disabled={!ed}
    commitments={t.ticket.commitments ?? {}}
    oncommit={(uid, at) => void patch({ commitments: { [uid]: at } })}
    onchange={(c) => void onFieldChange(c)}
  />
  {#if problem}
    <p
      class="rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5 text-xs text-danger"
      role="alert"
    >
      Board script: {problem}
    </p>
  {/if}

  {#snippet linksBody()}
    <LinksEditor compact />
  {/snippet}
  {@render row('Links', linksBody)}
</div>
