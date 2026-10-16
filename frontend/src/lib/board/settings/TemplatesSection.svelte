<!--
  Board settings › Templates.

  1. THE BOARD'S TEMPLATES (docs/plan/templates.html §F) — code the board's
     admins write (or ask an agent to write) for three places: message
     templates (the composer's 📋), ticket templates (New ticket) and card
     templates (a kanban view's cards). ?t={id} opens one in the editor,
     ?new={kind} starts one.
  2. COPY THIS BOARD — TaskManager's board templates are boards: start a new
     board from this one (boardCreate { template: { fromBoardId } } copies its
     stages, priorities, tags, custom fields, shared views and templates —
     never its people or tickets).
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ClipboardList, Copy, LayoutTemplate, Plus, SquarePen } from 'lucide-svelte';
  import { BoardKeySchema, indicatorOf, TEMPLATE_KINDS, type TemplateKind } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Indicator from '$lib/ui/Indicator.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import TemplateEditor from '$lib/templates/TemplateEditor.svelte';
  import { boardTemplates } from '$lib/templates/store';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();

  // ── 1. the board's templates ──
  const store = $derived(boardTemplates(s.board.id));
  const all = $derived(
    [...$store.data].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
  );
  const openId = $derived(page.url.searchParams.get('t'));
  const newKind = $derived(page.url.searchParams.get('new') as TemplateKind | null);
  const editing = $derived(openId ? (all.find((x) => x.id === openId) ?? null) : null);
  const editorKind = $derived<TemplateKind | null>(
    editing ? editing.kind : newKind && TEMPLATE_KINDS.includes(newKind) ? newKind : null,
  );
  const me = $derived({
    id: s.me,
    name: auth.profile?.name || s.members.find((m) => m.uid === s.me)?.name || '',
    email: auth.user?.email ?? '',
    role: s.role ?? '',
  });

  const KINDS: { kind: TemplateKind; title: string; blurb: string }[] = [
    {
      kind: 'message',
      title: 'Message templates',
      blurb: 'Forms in the composer (📋) whose answer is posted as a message.',
    },
    {
      kind: 'ticket',
      title: 'Ticket templates',
      blurb: 'Forms in New ticket that fill in the ticket the way this board wants it.',
    },
    {
      kind: 'card',
      title: 'Card templates',
      blurb: 'What a kanban card shows. Pick one in a view’s Layout › Card.',
    },
  ];
  const go = (q: string) => goto(`${routes.boardSettings(s.board.key, 'templates')}${q}`);

  // ── 2. copy this board ──
  let name = $state(`${s.board.name} (copy)`);
  let key = $state('');
  let keyError = $state<string | null>(null);
  let busy = $state(false);
  const keyOk = $derived(BoardKeySchema.safeParse(key).success);

  const copied = $derived([
    `${s.board.stages.length} stages`,
    `${s.board.priorities.length} priorities`,
    `${s.board.tags.length} tags`,
    `${s.board.fields.filter((f) => !f.archived).length} custom fields`,
    'shared views',
    `${all.length} templates`,
  ]);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || !keyOk) return;
    busy = true;
    keyError = null;
    try {
      await command(
        'boardCreate',
        {
          name: name.trim(),
          key,
          template: { fromBoardId: s.board.id },
          color: s.board.color,
          icon: s.board.icon,
          indicator: indicatorOf(s.board, s.board.id),
        },
        { toast: false },
      );
      toast.success(`Created ${key}`, 'You are its admin. Invite people from People & roles.');
      void goto(routes.board(key));
    } catch (err) {
      if (isAppError(err) && err.code === 'conflict')
        keyError = `${key} is taken — pick another key`;
      else toast.error('Could not create the board', isAppError(err) ? err.message : undefined);
    } finally {
      busy = false;
    }
  }
</script>

{#if editorKind && (editing || !openId)}
  {#key editing?.id ?? `new:${editorKind}`}
    <TemplateEditor
      board={s.board}
      {me}
      canEdit={!s.readOnly}
      template={editing}
      kind={editorKind}
      onclose={() => go('')}
      onsaved={(id) => go(`?t=${encodeURIComponent(id)}`)}
    />
  {/key}
{:else}
  <Section
    title="Templates"
    description="Your board's own forms and cards, written as a little JavaScript (or by asking an agent — it is all in the MCP tools). The code runs sandboxed in each person's browser and can only read this board, as them."
  >
    {#if openId && !$store.loading}
      <p class="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        That template no longer exists.
      </p>
    {/if}
    <div class="flex flex-col gap-6">
      {#each KINDS as k (k.kind)}
        {@const list = all.filter((x) => x.kind === k.kind)}
        <div class="flex max-w-3xl flex-col gap-2" data-testid="templates-{k.kind}">
          <div class="flex items-end justify-between gap-3">
            <div>
              <h3 class="flex items-center gap-1.5 font-medium">
                {#if k.kind === 'card'}<LayoutTemplate size={15} />{:else}<ClipboardList
                    size={15}
                  />{/if}
                {k.title}
              </h3>
              <p class="text-sm text-muted">{k.blurb}</p>
            </div>
            {#if !s.readOnly}
              <Button size="sm" icon={Plus} onclick={() => go(`?new=${k.kind}`)}>New</Button>
            {/if}
          </div>
          <ul class="divide-y divide-line rounded-xl border border-line bg-surface">
            {#each list as t (t.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
                  onclick={() => go(`?t=${encodeURIComponent(t.id)}`)}
                >
                  <Indicator of={t} seed={t.id} size="md" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium">{t.name}</span>
                    {#if t.description}<span class="block truncate text-xs text-muted"
                        >{t.description}</span
                      >{/if}
                  </span>
                  <SquarePen size={14} class="shrink-0 text-subtle" />
                </button>
              </li>
            {:else}
              <li class="px-4 py-3 text-sm text-subtle">None yet.</li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  </Section>

  <div class="mt-10">
    <Section
      title="Copy this board"
      description="Use this board as the starting point for another one. Built-in templates (Blank, Kanban, Bug tracker) are offered when you create a board."
    >
      <form
        class="flex max-w-xl flex-col gap-4 rounded-xl border border-line bg-surface p-5"
        onsubmit={create}
      >
        <div>
          <h3 class="font-medium">New board from {s.board.key}</h3>
          <p class="mt-0.5 text-sm text-muted">
            Copies {copied.join(', ')}. People, tickets and integrations stay here.
          </p>
        </div>
        <Input label="Name" bind:value={name} maxlength={80} required />
        <Input
          label="Key"
          value={key}
          maxlength={6}
          required
          placeholder="OPS"
          class="w-40"
          hint="2–6 letters or digits, starting with a letter. Fixed once created."
          error={keyError ?? (key && !keyOk ? 'A–Z first, then A–Z / 0–9, 2–6 characters' : null)}
          oninput={(e) => {
            key = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            keyError = null;
          }}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            icon={Copy}
            loading={busy}
            disabled={!name.trim() || !keyOk}>Create board</Button
          >
        </div>
      </form>
    </Section>
  </div>
{/if}
