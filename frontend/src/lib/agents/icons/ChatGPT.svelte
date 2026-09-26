<!-- ChatGPT mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="chatgpt"
>
  <g stroke="currentColor" stroke-width="1.8">
    <rect x="9.25" y="2.75" width="5.5" height="18.5" rx="2.75" />
    <rect x="9.25" y="2.75" width="5.5" height="18.5" rx="2.75" transform="rotate(60 12 12)" />
    <rect x="9.25" y="2.75" width="5.5" height="18.5" rx="2.75" transform="rotate(120 12 12)" />
  </g>
</svg>
