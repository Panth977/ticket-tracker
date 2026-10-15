<!--
  /{handle}/settings/{section} (rerouted here) — an ORG's settings
  (agents.html §AC), for its owners and admins:
    general   picture, name, handle, and the base role every member gets on what it owns
    members   who is in it and as what; invite by e-mail
    env       key/value pairs its boards, artifacts and buckets inherit
    danger    delete it (once it owns nothing); leave it
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ORG_BASE_ROLES, ORG_ROLES, type OrgBaseRole, type OrgRole } from '@tm/shared';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import EnvEditor from '$lib/env/EnvEditor.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { orgDoc } from '$lib/orgs/store';
  import OrgPictureEditor from '$lib/orgs/OrgPictureEditor.svelte';
  import PersonName from '$lib/orgs/PersonName.svelte';
  import { Button, EmptyState, Input, Select, Skeleton, toast } from '$lib/ui';
  import Textarea from '$lib/ui/Textarea.svelte';
  import { isEmail, splitEmails } from '$lib/account/inviteDraft';

  const handle = $derived((page.params.handle ?? '').toLowerCase());
  const section = $derived(page.params.section ?? 'general');
  let orgId = $state<string | null>(null);
  let missing = $state(false);
  $effect(() => {
    const h = handle;
    orgId = null;
    missing = false;
    command('pathResolve', { handle: h })
      .then((r) => (r.owner.kind === 'org' ? (orgId = r.owner.id) : (missing = true)))
      .catch(() => (missing = true));
  });
  const orgQ = $derived(orgDoc(orgId));
  const org = $derived($orgQ.data);
  const me = $derived(auth.uid ?? '');
  const myRole = $derived(org?.members[me] ?? null);
  const manage = $derived(myRole === 'owner' || myRole === 'admin');

  const SECTIONS = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' },
    { id: 'env', label: 'Env' },
    { id: 'danger', label: 'Danger zone' },
  ] as const;

  // ── general ──
  let name = $state('');
  let newHandle = $state('');
  let baseRole = $state<OrgBaseRole>('editor');
  $effect(() => {
    if (org) {
      name = org.name;
      newHandle = org.handle;
      baseRole = org.baseRole;
    }
  });
  let busy = $state(false);
  async function saveGeneral() {
    if (!orgId || !org) return;
    busy = true;
    try {
      await command(
        'orgUpdate',
        {
          orgId,
          ...(name.trim() !== org.name ? { name: name.trim() } : {}),
          ...(newHandle !== org.handle ? { handle: newHandle } : {}),
          ...(baseRole !== org.baseRole ? { baseRole } : {}),
        },
        { toast: 'Could not save' },
      );
      toast.success('Saved');
      if (newHandle !== org.handle)
        await goto(routes.orgSettings(newHandle, 'general'), { replaceState: true });
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }

  // ── members ──
  let invites = $state('');
  let inviteRole = $state<OrgRole>('member');
  async function invite(e: Event) {
    e.preventDefault();
    if (!orgId) return;
    const emails = splitEmails(invites).filter(isEmail);
    if (!emails.length) return;
    busy = true;
    try {
      const r = await command(
        'orgInvite',
        { orgId, invites: emails.map((email) => ({ email, role: inviteRole })) },
        { toast: 'Could not invite' },
      );
      invites = '';
      toast.success(
        `Invited ${r.invited.length}${r.alreadyMembers.length ? ` · ${r.alreadyMembers.length} already in` : ''}`,
      );
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
  async function setRole(uid: string, role: OrgRole | null) {
    if (!orgId) return;
    try {
      await command('orgMemberSet', { orgId, uid, role }, { toast: 'Could not change it' });
      if (uid === me && role === null) await goto(routes.home());
    } catch {
      /* toasted */
    }
  }

  async function del() {
    if (!orgId) return;
    try {
      await command('orgDelete', { orgId }, { toast: 'Could not delete the org' });
      await goto(routes.home());
    } catch {
      /* toasted */
    }
  }
  const BASE: Record<OrgBaseRole, string> = {
    none: 'None — only what they are given',
    viewer: 'Viewer',
    commenter: 'Commenter',
    editor: 'Editor',
    admin: 'Admin',
  };
</script>

<svelte:head><title>{org?.name ?? handle} settings · TaskManager</title></svelte:head>

<div class="mx-auto flex w-full max-w-5xl gap-8 px-4 py-8 sm:px-8">
  {#if missing}
    <EmptyState
      title="No such org"
      description="No org goes by “{handle}”, or you are not in it."
    />
  {:else if !org}
    <Skeleton width="40%" height="2rem" />
  {:else}
    <nav aria-label="Org settings" class="flex w-44 shrink-0 flex-col gap-1 text-sm">
      <a href={routes.owner(org.handle)} class="mb-2 truncate font-medium">← {org.name}</a>
      {#each SECTIONS as s (s.id)}
        <a
          href={routes.orgSettings(org.handle, s.id)}
          aria-current={section === s.id ? 'page' : undefined}
          class="rounded-md px-2 py-1 {section === s.id
            ? 'bg-surface-3 font-medium'
            : 'text-muted hover:bg-surface-2'}">{s.label}</a
        >
      {/each}
    </nav>
    <div class="min-w-0 flex-1">
      {#if section === 'general'}
        <Section
          title="General"
          description="Its picture, its name, its address, and what every member gets."
        >
          <div class="flex max-w-md flex-col gap-4">
            <OrgPictureEditor {org} disabled={!manage} />
            <Input label="Name" bind:value={name} disabled={!manage} />
            <Input
              label="Handle"
              hint="Its address: /{newHandle}"
              bind:value={newHandle}
              disabled={!manage}
            />
            <Select
              label="Every member gets"
              options={ORG_BASE_ROLES.map((r) => ({ value: r, label: BASE[r] }))}
              bind:value={baseRole}
              disabled={!manage}
              hint="On every board, artifact and bucket the org owns. Changing it re-applies it to all of them."
            />
            {#if manage}<div>
                <Button variant="primary" loading={busy} onclick={saveGeneral}>Save</Button>
              </div>{/if}
          </div>
        </Section>
      {:else if section === 'members'}
        <Section
          title="Members"
          description="Owners and admins manage the org and get full access to everything it owns."
        >
          <ul class="flex flex-col divide-y divide-line" data-org-members>
            {#each Object.entries(org.members).sort( ([a], [b]) => a.localeCompare(b) ) as [uid, role] (uid)}
              <li class="flex items-center gap-3 py-2" data-org-member={uid}>
                <span class="min-w-0 flex-1 truncate text-sm"
                  ><PersonName {uid} />{uid === me ? ' (you)' : ''}</span
                >
                {#if manage && (myRole === 'owner' || role !== 'owner')}
                  <Select
                    aria-label="Role"
                    options={ORG_ROLES.filter((r) => myRole === 'owner' || r !== 'owner').map(
                      (r) => ({ value: r, label: r }),
                    )}
                    value={role}
                    onchange={(e) =>
                      setRole(uid, (e.currentTarget as HTMLSelectElement).value as OrgRole)}
                  />
                  <Button variant="ghost" onclick={() => setRole(uid, null)}
                    >{uid === me ? 'Leave' : 'Remove'}</Button
                  >
                {:else}
                  <span class="text-sm text-muted">{role}</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if manage}
            <form class="mt-4 flex max-w-xl flex-col gap-3" onsubmit={invite}>
              <Textarea
                label="Invite"
                placeholder="asha@example.com, priya@example.com"
                bind:value={invites}
                rows={2}
                autosize
              />
              <div class="flex items-end gap-2">
                <Select
                  label="As"
                  options={ORG_ROLES.filter((r) => myRole === 'owner' || r !== 'owner').map(
                    (r) => ({ value: r, label: r }),
                  )}
                  bind:value={inviteRole}
                />
                <Button variant="primary" type="submit" loading={busy} disabled={!invites.trim()}
                  >Invite</Button
                >
              </div>
            </form>
          {/if}
        </Section>
      {:else if section === 'env'}
        <Section
          title="Env"
          description="Key/value pairs every board, artifact and bucket of this org inherits (theirs win). Plain text, not for secrets."
        >
          <EnvEditor kind="org" id={orgId ?? ''} canEdit={manage} />
        </Section>
      {:else if section === 'danger'}
        <Section title="Danger zone" description="Leaving or deleting takes effect at once.">
          <div class="flex flex-col items-start gap-3">
            {#if myRole}
              <Button variant="ghost" onclick={() => setRole(me, null)}>Leave {org.name}</Button>
            {/if}
            {#if myRole === 'owner'}
              <Button variant="danger" onclick={del}>Delete {org.name}</Button>
              <p class="text-sm text-muted">
                Only an org that owns nothing can be deleted: move or delete its boards, artifacts
                and buckets first.
              </p>
            {/if}
          </div>
        </Section>
      {/if}
    </div>
  {/if}
</div>
