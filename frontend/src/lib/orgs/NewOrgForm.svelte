<!--
  New org (agents.html §AC): a handle (its URL, /{handle}), a name, and the
  base role every member gets on everything the org owns. You become its owner.
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import {
    HANDLE_RE,
    ORG_BASE_ROLES,
    RESERVED_HANDLES,
    handleFrom,
    type OrgBaseRole,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { routes } from '$lib/layout/routes';
  import Button from '$lib/ui/Button.svelte';
  import CreatePage from '$lib/ui/CreatePage.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Select from '$lib/ui/Select.svelte';

  /** A page opens once: the form starts fresh (the reset below runs once). */
  let open = $state(true);

  let name = $state('');
  let handle = $state('');
  let touched = $state(false);
  let baseRole = $state<OrgBaseRole>('editor');
  let busy = $state(false);

  $effect(() => {
    if (open) {
      name = '';
      handle = '';
      touched = false;
      baseRole = 'editor';
    }
  });
  $effect(() => {
    if (!touched) handle = name.trim() ? handleFrom(name) : '';
  });

  const BASE: Record<OrgBaseRole, string> = {
    none: 'None — only what they are given',
    viewer: 'Viewer',
    commenter: 'Commenter',
    editor: 'Editor',
    admin: 'Admin',
  };
  const handleError = $derived(
    !handle
      ? null
      : RESERVED_HANDLES.has(handle)
        ? 'That name is used by the app'
        : HANDLE_RE.test(handle)
          ? null
          : '2–39 of a–z, 0–9 and -, not starting or ending with -',
  );

  async function create(e: Event) {
    e.preventDefault();
    if (handleError || !name.trim() || !handle) return;
    busy = true;
    try {
      const r = await command(
        'orgCreate',
        { handle, name: name.trim(), baseRole },
        { toast: 'Could not create the org' },
      );
      open = false;
      await goto(routes.owner(r.handle));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<CreatePage
  title="New org"
  description="An org owns boards, artifacts and buckets; its members reach all of them."
>
  <form id="new-org-form" class="flex flex-col gap-4" onsubmit={create}>
    <Input label="Name" bind:value={name} maxlength={80} required />
    <Input
      label="Handle"
      hint="Its address: /{handle || 'handle'}"
      bind:value={handle}
      oninput={() => (touched = true)}
      error={handleError}
      required
    />
    <Select
      label="Every member gets"
      options={ORG_BASE_ROLES.map((r) => ({ value: r, label: BASE[r] }))}
      bind:value={baseRole}
      hint="On every board, artifact and bucket the org owns. Owners and admins always get full access."
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => history.back()}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="new-org-form"
      disabled={!name.trim() || !handle || !!handleError}
      loading={busy}>Create org</Button
    >
  {/snippet}
</CreatePage>
