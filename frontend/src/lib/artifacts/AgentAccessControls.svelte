<!--
  An agent's permission on ONE artifact (agents.html §AA3): two controls,
  separately — a Build checkbox and a Data select (None / Read / Read & write).
  Used by the artifact's People section and by the agent's own Access card, so
  the two screens can never disagree about what the controls mean.

  CONTROLLED: `access` is what the live document says (read with agentAccessOf,
  so a legacy 'editor' shows as Build + Read & write). A click reports the
  PATCH and the control snaps back; it shows the new value when the document
  does. That matters for one case above all: turning off the last permission
  is "remove the agent" to artifactShare, the parent asks first, and if the
  answer is no the control must still say what is true.

    <AgentAccessControls {access} name="Builder" onchange={(patch) => …} />
-->
<script lang="ts">
  import type { ArtifactAgentAccess } from '@tm/shared';
  import {
    AGENT_BUILD_HINT,
    AGENT_DATA_HINT,
    AGENT_DATA_LABEL,
    AGENT_DATA_ORDER,
    type AgentData,
  } from '$lib/agents/access';

  interface Props {
    access: ArtifactAgentAccess;
    /** For the labels screen readers hear: "Build — Builder on Sales dashboard". */
    name: string;
    disabled?: boolean;
    /** Why it is disabled (a tooltip), e.g. "Only the owner can change this". */
    reason?: string;
    onchange: (patch: Partial<ArtifactAgentAccess>) => void;
    class?: string;
  }
  let { access, name, disabled = false, reason, onchange, class: cls = '' }: Props = $props();
</script>

<span class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm {cls}" data-agent-access>
  <label
    class="flex items-center gap-1.5 {disabled ? 'text-muted' : 'cursor-pointer'}"
    title={disabled && reason ? reason : AGENT_BUILD_HINT}
  >
    <input
      type="checkbox"
      class="size-4 accent-[var(--tm-accent)]"
      checked={access.build}
      {disabled}
      aria-label="Build — {name}"
      onchange={(e) => {
        const build = e.currentTarget.checked;
        e.currentTarget.checked = access.build; // the live document decides what shows
        onchange({ build });
      }}
    />
    Build
  </label>
  <label
    class="flex items-center gap-1.5"
    title={disabled && reason ? reason : AGENT_DATA_HINT[access.data]}
  >
    <span class="text-muted">Data</span>
    <select
      class="h-8 rounded-md border border-line bg-surface px-1.5 text-sm"
      value={access.data}
      {disabled}
      aria-label="Data — {name}"
      onchange={(e) => {
        const data = e.currentTarget.value as AgentData;
        e.currentTarget.value = access.data;
        onchange({ data });
      }}
    >
      {#each AGENT_DATA_ORDER as d (d)}<option value={d}>{AGENT_DATA_LABEL[d]}</option>{/each}
    </select>
  </label>
</span>
