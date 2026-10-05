<!--
  Memory settings › People (owner only; memory.html §B). A memory's people
  are its own: memoryShare by email with a role (editor | viewer), null
  removes. There are no invites: the person must have signed in once (an
  unknown address is a 409 'noAccount', said in words here). Agents are not
  shared here — an agent reaches a memory through a board (D-M4).
-->
<script lang="ts">
  import { Mail, Send } from 'lucide-svelte';
  import type { MemoryShareRole } from '@tm/shared';
  import { command, isAppError } from '$lib/api';
  import PersonRow from '$lib/artifacts/settings/PersonRow.svelte';
  import Section from '$lib/board/settings/Section.svelte';
  import { Button, toast } from '$lib/ui';
  import { memoryAccessRows } from '../store';
  import { useMemorySettings } from './context.svelte';

  const s = useMemorySettings();
  const m = $derived(s.memory);
  const editable = $derived(s.isOwner && m.archivedAt == null);
  const people = $derived(memoryAccessRows(m));

  const ROLE_LABEL: Record<MemoryShareRole, string> = { editor: 'Editor', viewer: 'Viewer' };

  let working = $state(false);
  async function share(email: string, role: MemoryShareRole | null, headline: string) {
    working = true;
    try {
      return await command('memoryShare', { memoryId: m.id, email, role }, { toast: false });
    } catch (e) {
      if (isAppError(e) && (e.details as { reason?: string } | undefined)?.reason === 'noAccount')
        toast.error(
          'No account with that email yet',
          'Ask them to sign in once first, then share again.',
        );
      else toast.error(headline, isAppError(e) ? e.message : undefined);
      return null;
    } finally {
      working = false;
    }
  }

  let email = $state('');
  let role = $state<MemoryShareRole>('viewer');
  const clean = $derived(email.trim().toLowerCase());
  const valid = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean));

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!valid) return;
    const r = await share(clean, role, 'Could not share the memory');
    if (!r) return;
    toast.success(
      `Shared with ${clean}`,
      `They can open it now as ${ROLE_LABEL[role].toLowerCase()}.`,
    );
    email = '';
  }
  async function setRole(personEmail: string, r: MemoryShareRole) {
    if (await share(personEmail, r, 'Could not change the role'))
      toast.success(`${personEmail} is now ${ROLE_LABEL[r].toLowerCase()}`);
  }
  async function remove(personEmail: string, name: string) {
    if (!confirm(`Remove ${name} from ${m.name}? They lose access to its files at once.`)) return;
    if (await share(personEmail, null, 'Could not remove them')) toast.success(`Removed ${name}`);
  }
</script>

<Section
  title="People"
  description="Who can open this memory. Boards and artifacts that use it are listed under Subscribers."
>
  <div class="flex flex-col gap-6">
    {#if editable}
      <form
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
        onsubmit={add}
        aria-label="Share with someone"
      >
        <h3 class="flex items-center gap-1.5 font-medium"><Mail size={15} /> Add by email</h3>
        <div class="flex flex-wrap gap-2">
          <input
            type="email"
            bind:value={email}
            placeholder="name@example.com"
            aria-label="Email"
            class="h-8 min-w-48 flex-1 rounded-md border border-line bg-surface px-2.5 text-sm focus:border-accent focus:outline-none"
          />
          <select
            bind:value={role}
            aria-label="Role"
            class="h-8 rounded-md border border-line bg-surface px-2 text-sm"
          >
            <option value="viewer">Viewer — browse and download</option>
            <option value="editor">Editor — upload, edit, move, delete</option>
          </select>
          <Button type="submit" variant="primary" icon={Send} disabled={!valid} loading={working}
            >Share</Button
          >
        </div>
      </form>
    {/if}
    <div class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="w-full min-w-[28rem] text-sm">
        <thead class="border-b border-line text-left text-xs text-muted">
          <tr>
            <th class="px-4 py-2 font-medium">Person</th>
            <th class="px-2 py-2 font-medium">Role</th>
            <th class="w-10 px-2 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          {#each people as p (p.uid)}
            <PersonRow
              uid={p.uid}
              role={p.role}
              self={p.uid === s.me}
              {editable}
              busy={working}
              onrole={(em, r) => void setRole(em, r)}
              onremove={(em, name) => void remove(em, name)}
            />
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</Section>
