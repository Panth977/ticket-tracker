<!-- Copilot mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="copilot"
>
  <path
    d="M4 11.5C4 7 7.5 4.5 12 4.5s8 2.5 8 7V14c0 1.4-.8 2.3-2 2.8L12 20l-6-3.2c-1.2-.5-2-1.4-2-2.8z"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linejoin="round"
  />
  <rect x="7" y="10" width="4" height="4" rx="1.2" fill="currentColor" />
  <rect x="13" y="10" width="4" height="4" rx="1.2" fill="currentColor" />
</svg>
