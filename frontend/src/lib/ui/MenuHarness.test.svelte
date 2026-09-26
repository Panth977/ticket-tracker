<script lang="ts">
  import Menu from './Menu.svelte';
  let { onSelect }: { onSelect: () => void } = $props();
</script>

<Menu items={[{ label: 'Rename' }, { label: 'Archive', onSelect }]}>
  {#snippet trigger(props)}<button {...props}>Actions</button>{/snippet}
</Menu>
