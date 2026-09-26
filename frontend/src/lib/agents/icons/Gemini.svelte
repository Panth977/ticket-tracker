<!-- Gemini mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="gemini"
>
  <path
    fill="currentColor"
    d="M12 2c0 5.52 4.48 10 10 10-5.52 0-10 4.48-10 10 0-5.52-4.48-10-10-10 5.52 0 10-4.48 10-10z"
  />
</svg>
