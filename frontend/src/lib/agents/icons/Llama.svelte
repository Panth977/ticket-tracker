<!-- Llama (Meta) mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="llama"
>
  <path
    d="M3 12c0-2.8 1.5-5 3.5-5 4 0 7 10 11 10 2 0 3.5-2.2 3.5-5s-1.5-5-3.5-5c-4 0-7 10-11 10C4.5 17 3 14.8 3 12z"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linejoin="round"
  />
</svg>
