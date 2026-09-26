<!-- Test stand-in for lucide-svelte icons (their Svelte 4 components don't compile under runes: true). -->
<script lang="ts">
  let { size = 16 }: { size?: number; [k: string]: unknown } = $props();
</script>

<svg width={size} height={size} aria-hidden="true"></svg>
