<!-- Claude mark — a small monochrome (currentColor) approximation, drawn here so no dependency is needed. -->
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
  data-brand="claude"
>
  <path
    d="M12.00 9.60L12.00 3.40M13.41 10.06L15.64 6.98M14.28 11.26L19.80 9.47M14.28 12.74L17.33 13.73M13.41 13.94L17.05 18.96M12.00 14.40L12.00 18.40M10.59 13.94L7.30 18.47M9.72 12.74L6.48 13.79M9.72 11.26L3.82 9.34M10.59 10.06L8.47 7.15"
    stroke="currentColor"
    stroke-width="2.6"
    stroke-linecap="round"
  />
</svg>
