<!--
  Artifact settings › People (owner only; docs/plan/artifacts.html §B).
  An artifact's people are its own — being on a board gives nothing here.

    Add by email · Role ▾            → artifactShare { email, role }
      has an account → the role at once ('granted'); no account → an invite
      that waits for their first sign-in ('invited')
    Person · Role · Remove           owner fixed; editor ⇄ viewer; remove = role null
    Agents                           not here: Settings › Subscribers lists them,
                                     and an agent is added from its own page
                                     (lib/access)
    Pending invites                  invites/ where artifactId == this (the rules
                                     let the owner list them); remove = role null
-->
<script lang="ts">
  import { Clock, Mail, Send, X } from 'lucide-svelte';
  import { paths, type ArtifactShareRole, type Invite } from '@tm/shared';
  import { command } from '$lib/api';
  import Section from '$lib/board/settings/Section.svelte';
  import { queryStore } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { accessRows } from '../store';
  import { useArtifactSettings } from './context.svelte';
  import PersonRow from './PersonRow.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  // Sharing an archived artifact would hand people something they cannot use.
  const editable = $derived(s.isOwner && a.archivedAt == null);
  const people = $derived(accessRows(a));
  const ROLE_LABEL: Record<ArtifactShareRole, string> = { editor: 'Editor', viewer: 'Viewer' };
  const ROLE_HINT: Record<ArtifactShareRole, string> = {
    editor: 'Opens it, reads and writes its data, publishes builds and rolls back',
    viewer: 'Opens it and reads its data; writes too unless it is read-only for viewers',
  };

  /** The one call every PERSON row makes. Returns the outcome, or null when it failed (toasted). */
  let working = $state<string | null>(null);
  async function share(who: { email: string }, role: ArtifactShareRole | null, headline: string) {
    working = who.email;
    try {
      const r = await command(
        'artifactShare',
        { artifactId: a.id, ...who, role },
        { toast: headline },
      );
      return r.outcome;
    } catch {
      return null;
    } finally {
      working = null;
    }
  }

  // ── add by email ──
  let email = $state('');
  let role = $state<ArtifactShareRole>('viewer');
  const clean = $derived(email.trim().toLowerCase());
  const valid = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean));

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!valid) return;
    const outcome = await share({ email: clean }, role, 'Could not share the artifact');
    if (!outcome) return;
    toast.success(
      outcome === 'invited' ? `Invited ${clean}` : `Shared with ${clean}`,
      outcome === 'invited'
        ? 'They have no account yet — the invite waits for their first sign-in.'
        : `They can open it now as ${ROLE_LABEL[role].toLowerCase()}.`,
    );
    email = '';
  }
  async function setRole(personEmail: string, r: ArtifactShareRole) {
    if (await share({ email: personEmail }, r, 'Could not change the role'))
      toast.success(`${personEmail} is now ${ROLE_LABEL[r].toLowerCase()}`);
  }
  async function remove(personEmail: string, name: string) {
    if (!confirm(`Remove ${name} from ${a.name}? They lose access to it and its data at once.`))
      return;
    if (await share({ email: personEmail }, null, 'Could not remove them'))
      toast.success(`Removed ${name}`);
  }

  // ── pending invites (people with no account yet) ──
  const invitesQ = $derived(
    queryStore<Invite>(
      s.isOwner
        ? {
            path: paths.invites(),
            where: [
              ['artifactId', '==', a.id],
              ['status', '==', 'pending'],
            ],
          }
        : null,
    ),
  );
  const invites = $derived([...$invitesQ.data].sort((x, y) => y.createdAt - x.createdAt));
  async function revoke(inv: Invite) {
    if (await share({ email: inv.email }, null, 'Could not remove the invite'))
      toast.success(`Removed the invite for ${inv.email}`);
  }
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms);
</script>

<Section
  title="People"
  description="Who can open this artifact. Only signed-in people listed here can reach it — there is no public link."
>
  <div class="flex flex-col gap-6">
    {#if editable}
      <form
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
        onsubmit={add}
        aria-label="Share with someone"
      >
        <div>
          <h3 class="flex items-center gap-1.5 font-medium"><Mail size={15} /> Add by email</h3>
          <p class="text-sm text-muted">
            Someone with an account gets it at once. Anyone else gets an invite that waits for their
            first sign-in.
          </p>
        </div>
        <div class="flex flex-wrap items-start gap-2">
          <label class="min-w-56 flex-1">
            <span class="sr-only">Email address</span>
            <input
              type="email"
              bind:value={email}
              placeholder="ana@example.com"
              autocomplete="off"
              class="h-9 w-full rounded-md border border-line bg-bg px-2.5 text-sm outline-none focus:border-accent"
            />
          </label>
          <label>
            <span class="sr-only">Role</span>
            <select
              bind:value={role}
              class="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              title={ROLE_HINT[role]}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            icon={Send}
            loading={working === clean && !!clean}
            disabled={!valid}>Share</Button
          >
        </div>
        <p class="text-xs text-muted">{ROLE_LABEL[role]}: {ROLE_HINT[role]}.</p>
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
              busy={working != null}
              onrole={(em, r) => void setRole(em, r)}
              onremove={(em, name) => void remove(em, name)}
            />
          {/each}
        </tbody>
      </table>
    </div>

    {#if s.isOwner && (invites.length || $invitesQ.error)}
      <section class="flex flex-col gap-2" aria-label="Pending invites">
        <h3 class="flex items-center gap-1.5 font-medium">
          <Clock size={15} /> Pending invites
          <span class="text-sm font-normal text-muted">{invites.length}</span>
        </h3>
        {#if $invitesQ.error}
          <p class="text-sm text-danger">Couldn't load invites: {$invitesQ.error.message}</p>
        {:else}
          <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {#each invites as inv (inv.id)}
              {@const expired = inv.expiresAt < Date.now()}
              <li class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span class="min-w-0 flex-1">
                  <span class="font-medium">{inv.email}</span>
                  <span class="text-muted">
                    · {inv.role === 'editor' ? 'Editor' : 'Viewer'} · {expired
                      ? 'expired'
                      : `expires ${fmt(inv.expiresAt)}`}</span
                  >
                </span>
                {#if editable}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    disabled={working != null}
                    onclick={() => revoke(inv)}>Remove</Button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
</Section>
