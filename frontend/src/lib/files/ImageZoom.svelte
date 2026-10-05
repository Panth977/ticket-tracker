<!--
  An image lightbox body: fit to the stage, zoom (wheel / pinch-trackpad,
  + / − / 0 keys, double-click) around the pointer, drag to pan.
-->
<script lang="ts">
  import { Minus, Plus, Scan } from 'lucide-svelte';

  let { src, alt }: { src: string; alt: string } = $props();

  const MIN = 1;
  const MAX = 8;
  let scale = $state(1);
  let x = $state(0);
  let y = $state(0);
  let stage: HTMLDivElement | undefined = $state();
  let drag = $state<{ px: number; py: number; x: number; y: number } | null>(null);

  // A new image starts fitted.
  $effect(() => {
    void src;
    reset();
  });

  function reset() {
    scale = 1;
    x = 0;
    y = 0;
  }

  /** Zoom to `next`, keeping the point (cx, cy) — relative to the stage centre — still. */
  function zoomTo(next: number, cx = 0, cy = 0) {
    const s = Math.min(MAX, Math.max(MIN, next));
    if (s === MIN) return reset();
    const k = s / scale;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    scale = s;
  }

  function centreOffset(e: { clientX: number; clientY: number }) {
    const r = stage!.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const [cx, cy] = centreOffset(e);
    zoomTo(scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), cx, cy);
  }
  // Non-passive, so the page doesn't scroll while zooming.
  $effect(() => {
    const el = stage;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  function onDown(e: PointerEvent) {
    if (scale === 1 || e.button !== 0) return;
    drag = { px: e.clientX, py: e.clientY, x, y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!drag) return;
    x = drag.x + e.clientX - drag.px;
    y = drag.y + e.clientY - drag.py;
  }
  function onDbl(e: MouseEvent) {
    const [cx, cy] = centreOffset(e);
    zoomTo(scale > 1 ? 1 : 2.5, cx, cy);
  }
  export function key(e: KeyboardEvent): boolean {
    if (e.key === '+' || e.key === '=') zoomTo(scale * 1.25);
    else if (e.key === '-' || e.key === '_') zoomTo(scale / 1.25);
    else if (e.key === '0') reset();
    else return false;
    return true;
  }
</script>

<div class="relative size-full overflow-hidden">
  <!-- minmax(0,1fr) tracks give the cell a definite size, so max-h-full fits a tall image to the stage -->
  <div
    bind:this={stage}
    class="grid size-full touch-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center select-none {scale > 1
      ? drag
        ? 'cursor-grabbing'
        : 'cursor-grab'
      : 'cursor-zoom-in'}"
    role="img"
    aria-label={alt}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={() => (drag = null)}
    onpointercancel={() => (drag = null)}
    ondblclick={onDbl}
  >
    <img
      {src}
      {alt}
      draggable="false"
      class="max-h-full max-w-full object-contain"
      style="transform:translate({x}px,{y}px) scale({scale});transition:{drag
        ? 'none'
        : 'transform 0.12s ease-out'}"
    />
  </div>
  <div
    class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-1 text-white"
  >
    <button
      type="button"
      class="rounded-full p-1.5 hover:bg-white/15"
      aria-label="Zoom out"
      title="Zoom out (−)"
      onclick={() => zoomTo(scale / 1.25)}><Minus size={15} /></button
    >
    <button
      type="button"
      class="min-w-12 rounded-full px-1.5 py-1 text-xs tabular-nums hover:bg-white/15"
      aria-label="Reset zoom"
      title="Fit (0)"
      onclick={reset}>{Math.round(scale * 100)}%</button
    >
    <button
      type="button"
      class="rounded-full p-1.5 hover:bg-white/15"
      aria-label="Zoom in"
      title="Zoom in (+)"
      onclick={() => zoomTo(scale * 1.25)}><Plus size={15} /></button
    >
    <button
      type="button"
      class="rounded-full p-1.5 hover:bg-white/15"
      aria-label="Fit to screen"
      title="Fit (0)"
      onclick={reset}><Scan size={15} /></button
    >
  </div>
</div>
