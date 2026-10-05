<!--
  Board settings › Templates. TaskManager's templates are boards: Blank,
  Kanban and Bug tracker ship built in, and "copying an existing board covers
  the rest" (docs/plan/review.html › Board templates). Here: start a new
  board from THIS one — boardCreate { template: { fromBoardId } } copies its
  stages, priorities, tags, custom fields and shared views, never its people
  or tickets.
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { Copy } from 'lucide-svelte';
  import { BoardKeySchema, indicatorOf } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import Input from '$lib/ui/Input.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
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

<Section
  title="Templates"
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
