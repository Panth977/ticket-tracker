<!-- Cursor mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
<script lang="ts">
  let { size = 24, class: cls = '' }: { size?: number; class?: string } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  class={cls}
  aria-hidden="true"
  data-brand="cursor"
>
  <path fill="currentColor" opacity=".35" d="M12 2.5l8.2 4.75L12 12 3.8 7.25z" />
  <g stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
    <path d="M12 12l8.2-4.75M12 12v9.5M12 12L3.8 7.25" />
  </g>
</svg>
