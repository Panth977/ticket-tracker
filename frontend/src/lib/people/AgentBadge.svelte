<!-- The 'Agent' mark drawn next to every agent's name (agents.html §A). <AgentBadge /> · <AgentBadge compact /> -->
<script lang="ts">
  import { Bot } from 'lucide-svelte';

  let { compact = false, class: cls = '' }: { compact?: boolean; class?: string } = $props();
</script>

<span
  class="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent-soft px-1 py-px text-[10px] leading-tight font-semibold tracking-wide text-accent uppercase {cls}"
  title="Agent — acts through a token"
  data-agent-badge
>
  <Bot size={10} aria-hidden="true" />{#if !compact}Agent{:else}<span class="sr-only">Agent</span
    >{/if}
</span>
