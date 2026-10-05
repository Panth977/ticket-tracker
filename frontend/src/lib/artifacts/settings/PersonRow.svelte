<!--
  One person on an artifact (People section). Its own component because
  artifactShare names a person by EMAIL — the access map only has uids — and
  the email comes from that person's live profile (person(uid)), one
  subscription per row.
-->
<script lang="ts">
  import { UserMinus } from 'lucide-svelte';
  import type { ArtifactRole, ArtifactShareRole } from '@tm/shared';
  import { person, Principal } from '$lib/people';
  import IconButton from '$lib/ui/IconButton.svelte';

  interface Props {
    uid: string;
    role: ArtifactRole;
    self: boolean;
    /** The owner, on a live artifact, may change and remove. */
    editable: boolean;
    busy: boolean;
    onrole: (email: string, role: ArtifactShareRole) => void;
    onremove: (email: string, name: string) => void;
  }
  let { uid, role, self, editable, busy, onrole, onremove }: Props = $props();

  const p = $derived(person(uid));
  const email = $derived($p.person?.email ?? '');
  const name = $derived($p.person?.name ?? 'this person');
  // Without an address there is nothing to send artifactShare (a deleted account).
  const can = $derived(editable && role !== 'owner' && !!email);
</script>

<tr>
  <td class="px-4 py-2"
    ><Principal id={uid} layout="stacked" suffix={self ? '(you)' : undefined} /></td
  >
  <td class="px-2 py-2">
    {#if role === 'owner'}
      <span title="There is exactly one owner: whoever created it.">Owner</span>
    {:else if can}
      <select
        class="h-8 rounded-md border border-line bg-surface px-1.5"
        value={role}
        disabled={busy}
        aria-label="Role of {name}"
        onchange={(e) => {
          const r = e.currentTarget.value as ArtifactShareRole;
          e.currentTarget.value = role; // the live document decides what shows
          if (r !== role) onrole(email, r);
        }}
      >
        <option value="editor">Editor</option>
        <option value="viewer">Viewer</option>
      </select>
    {:else}
      <span>{role === 'editor' ? 'Editor' : 'Viewer'}</span>
    {/if}
  </td>
  <td class="w-10 px-2 py-2">
    {#if can}
      <IconButton
        icon={UserMinus}
        label="Remove {name}"
        size="sm"
        disabled={busy}
        onclick={() => onremove(email, name)}
      />
    {/if}
  </td>
</tr>
