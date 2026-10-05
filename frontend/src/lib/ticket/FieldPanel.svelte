<!--
  The field panel (app.json › Field panel): stage, priority, assignees (each
  with a commitment date), start / due, estimate, tags (+ create), links, then
  one editor per custom field. Every change is a ticketUpdate with an
  optimistic overlay; a commenter sees the stages their grant allows and
  nothing else editable.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import { indicatorColor, indicatorOf, type FieldValue, type TicketPatch } from '@tm/shared';
  import { command } from '$lib/api';
  import { DatePicker, toast } from '$lib/ui';
  import { getTicketCtx, updateTicket } from './context';
  import OptionPicker from './fields/OptionPicker.svelte';
  import CustomField from './fields/CustomField.svelte';
  import LinksEditor from './LinksEditor.svelte';
  import PersonAvatar from './PersonAvatar.svelte';

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
  const priorities = $derived(
    byPos(t.board.priorities).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
  const tags = $derived(
    byPos(t.board.tags).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
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
  const fields = $derived(byPos(t.board.fields).filter((f) => !f.archived));
  const ed = $derived(t.perms.edit);

  const patch = (p: TicketPatch) => updateTicket(t.boardId, t.ticketId, p, { key: t.ticket.key });

  async function createTag(name: string): Promise<string | null> {
    try {
      const { tag } = await command(
        'tagCreate',
        { boardId: t.boardId, name },
        { toast: 'Could not create the tag' },
      );
      return tag.id;
    } catch {
      return null;
    }
  }

  function setAssignees(uids: string[]) {
    // Dropping someone also drops their commitment date.
    const gone = t.ticket.assigneeUids.filter((u) => !uids.includes(u));
    const commitments = Object.fromEntries(
      gone.filter((u) => t.ticket.commitments?.[u] != null).map((u) => [u, null]),
    );
    void patch({ assigneeUids: uids, ...(Object.keys(commitments).length ? { commitments } : {}) });
  }

  let estDraft = $state<string | null>(null);
  function commitEstimate() {
    if (estDraft === null) return;
    const raw = estDraft.trim();
    estDraft = null;
    const n = raw === '' ? null : Number(raw.replace(',', '.'));
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      toast.error('The estimate must be a positive number');
      return;
    }
    if (n !== t.ticket.estimate) void patch({ estimate: n });
  }

  const required = $derived(new Set(t.board.stages.flatMap((s) => s.requires ?? [])));
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

  {#snippet priorityBody()}
    <OptionPicker
      label="Priority"
      options={priorities}
      value={t.ticket.priorityId ? [t.ticket.priorityId] : []}
      clearable
      disabled={!ed}
      onchange={(ids) => void patch({ priorityId: ids[0] ?? null })}
    />
  {/snippet}
  {@render row('Priority', priorityBody)}

  {#snippet assigneesBody()}
    <OptionPicker
      label="Assignees"
      options={people}
      value={t.ticket.assigneeUids}
      multiple
      disabled={!ed}
      placeholder="Unassigned"
      onchange={setAssignees}
      class={t.ticket.assigneeUids.length ? 'hidden' : ''}
    />
    {#if t.ticket.assigneeUids.length}
      <ul class="flex flex-col gap-1">
        {#each t.ticket.assigneeUids as uid (uid)}
          {@const m = t.members.find((x) => x.uid === uid)}
          <li class="group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-surface-2">
            <PersonAvatar {uid} size={20} />
            <span class="min-w-0 flex-1 truncate text-sm" title={m?.email}
              >{m?.name ?? 'Not on this board'}</span
            >
            <DatePicker
              value={t.ticket.commitments?.[uid] ?? null}
              tz={t.tz}
              withTime={false}
              placeholder="Commit…"
              disabled={!ed}
              class="w-28 [&_button]:h-7 [&_button]:border-transparent [&_button]:px-1.5 [&_button]:text-xs"
              onchange={(v) => void patch({ commitments: { [uid]: v } })}
            />
            {#if ed}
              <button
                type="button"
                aria-label="Unassign {m?.name ?? ''}"
                onclick={() => setAssignees(t.ticket.assigneeUids.filter((u) => u !== uid))}
                class="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                ><X size={13} /></button
              >
            {/if}
          </li>
        {/each}
      </ul>
      {#if ed}
        <OptionPicker
          label="Add assignees"
          options={people}
          value={t.ticket.assigneeUids}
          multiple
          placeholder="+ Add"
          onchange={setAssignees}
          class="text-xs [&_span]:text-subtle"
        />
      {/if}
    {/if}
  {/snippet}
  {@render row('Assignees', assigneesBody, 'Each assignee can set the date they commit to')}

  {#snippet startBody()}
    <DatePicker
      value={t.ticket.startAt}
      tz={t.tz}
      withTime={false}
      disabled={!ed}
      placeholder="No start"
      class="[&_button]:border-transparent"
      onchange={(v) => void patch({ startAt: v })}
    />
  {/snippet}
  {@render row('Start', startBody)}

  {#snippet dueBody()}
    <DatePicker
      value={t.ticket.dueAt}
      allDay={t.ticket.dueAllDay}
      tz={t.tz}
      disabled={!ed}
      placeholder="No due date"
      class="[&_button]:border-transparent"
      onchange={(v, allDay) => void patch({ dueAt: v, dueAllDay: allDay })}
    />
  {/snippet}
  {@render row('Due', dueBody)}

  {#snippet estimateBody()}
    <input
      type="text"
      inputmode="decimal"
      aria-label="Estimate"
      placeholder="—"
      disabled={!ed}
      value={estDraft ?? t.ticket.estimate ?? ''}
      oninput={(e) => (estDraft = e.currentTarget.value)}
      onblur={commitEstimate}
      onkeydown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          estDraft = null;
          e.currentTarget.blur();
        }
      }}
      class="h-8 w-24 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-line focus:border-accent focus:bg-surface focus:outline-none disabled:hover:border-transparent"
    />
  {/snippet}
  {@render row('Estimate', estimateBody)}

  {#snippet tagsBody()}
    <OptionPicker
      label="Tags"
      options={tags}
      value={t.ticket.tagIds}
      multiple
      disabled={!ed}
      placeholder="No tags"
      oncreate={ed ? createTag : undefined}
      onchange={(ids) => void patch({ tagIds: ids })}
    />
  {/snippet}
  {@render row('Tags', tagsBody)}

  {#snippet linksBody()}
    <LinksEditor compact />
  {/snippet}
  {@render row('Links', linksBody)}

  {#each fields as f (f.id)}
    {#snippet fieldBody()}
      <CustomField
        def={f}
        value={t.ticket.fields?.[f.id]}
        disabled={!ed || f.type === 'formula'}
        onchange={(v: FieldValue) => void patch({ fields: { [f.id]: v } })}
      />
    {/snippet}
    {@render row(
      f.name + (f.required || required.has(f.id) ? ' *' : ''),
      fieldBody,
      required.has(f.id) ? 'Needed before the ticket can enter some stages' : undefined,
    )}
  {/each}
</div>
