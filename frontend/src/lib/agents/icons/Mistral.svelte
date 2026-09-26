<!-- Mistral mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="mistral"
>
  <g fill="currentColor">
    <rect x="2" y="2" width="4" height="4" />
    <rect x="18" y="2" width="4" height="4" />
    <rect x="2" y="6" width="4" height="4" />
    <rect x="6" y="6" width="4" height="4" />
    <rect x="14" y="6" width="4" height="4" />
    <rect x="18" y="6" width="4" height="4" />
    <rect x="2" y="10" width="4" height="4" />
    <rect x="6" y="10" width="4" height="4" />
    <rect x="10" y="10" width="4" height="4" />
    <rect x="14" y="10" width="4" height="4" />
    <rect x="18" y="10" width="4" height="4" />
    <rect x="2" y="14" width="4" height="4" />
    <rect x="10" y="14" width="4" height="4" />
    <rect x="18" y="14" width="4" height="4" />
    <rect x="2" y="18" width="4" height="4" />
    <rect x="18" y="18" width="4" height="4" />
  </g>
</svg>
