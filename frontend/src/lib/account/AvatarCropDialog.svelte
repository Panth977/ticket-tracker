<!--
  The square crop frame shared by your own picture and your agents' pictures:
  drag to move, slider / wheel / keys to zoom, then `onsave(blob)` gets a 256px
  WebP. The caller uploads it and saves the path.
    <AvatarCropDialog bind:this={crop} title="Crop the picture" onsave={async (blob) => …} />
    crop.pick()   → opens the file chooser
-->
<script lang="ts">
  import { Button, Dialog, toast } from '$lib/ui';
  import {
    checkFile,
    clampCrop,
    coverScale,
    loadImage,
    renderAvatar,
    type CropState,
  } from './avatar';

  interface Props {
    title?: string;
    /** Upload + save; throw to keep the dialog open. */
    onsave: (blob: Blob) => Promise<void>;
  }
  let { title = 'Crop your picture', onsave }: Props = $props();

  const FRAME = 240;
  let input: HTMLInputElement | undefined = $state();
  let open = $state(false);
  let img = $state<HTMLImageElement | null>(null);
  let crop = $state<CropState>({ zoom: 1, x: 0, y: 0 });
  let saving = $state(false);
  let drag: { px: number; py: number; x: number; y: number } | null = null;

  const scale = $derived(
    img ? coverScale(img.naturalWidth, img.naturalHeight, FRAME) * crop.zoom : 1,
  );

  /** Open the file chooser. */
  export function pick() {
    input?.click();
  }

  function set(c: CropState) {
    if (img) crop = clampCrop(c, img.naturalWidth, img.naturalHeight, FRAME);
  }

  async function chosen(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    const bad = checkFile(file);
    if (bad) return void toast.error(bad);
    try {
      if (img) URL.revokeObjectURL(img.src);
      img = await loadImage(file);
      crop = { zoom: 1, x: 0, y: 0 };
      open = true;
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  function down(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
  }
  function move(e: PointerEvent) {
    if (!drag) return;
    set({ ...crop, x: drag.x + e.clientX - drag.px, y: drag.y + e.clientY - drag.py });
  }
  function up() {
    drag = null;
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    set({ ...crop, zoom: crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) });
  }
  function keys(e: KeyboardEvent) {
    const step = e.shiftKey ? 20 : 5;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      set({ ...crop, x: crop.x + m[0], y: crop.y + m[1] });
    } else if (e.key === '+' || e.key === '=') set({ ...crop, zoom: crop.zoom * 1.1 });
    else if (e.key === '-') set({ ...crop, zoom: crop.zoom / 1.1 });
  }

  async function save() {
    if (!img) return;
    saving = true;
    try {
      await onsave(await renderAvatar(img, crop, FRAME));
      open = false;
    } catch (err) {
      if (!(err as { code?: string }).code)
        toast.error('Could not upload the picture', (err as Error).message);
    } finally {
      saving = false;
    }
  }
</script>

<input
  bind:this={input}
  type="file"
  accept="image/*"
  class="sr-only"
  tabindex="-1"
  aria-hidden="true"
  onchange={chosen}
/>

<Dialog bind:open {title} description="Drag to move, scroll or use the slider to zoom." size="sm">
  {#if img}
    <div class="flex flex-col items-center gap-4">
      <!-- Drag / wheel / arrow keys move the picture; the zoom slider below is the plain control. -->
      <div
        class="relative cursor-grab touch-none overflow-hidden rounded-full border border-line bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
        style:width="{FRAME}px"
        style:height="{FRAME}px"
        role="button"
        aria-roledescription="crop area"
        aria-label="Crop area — arrow keys move, + and − zoom"
        tabindex="0"
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={up}
        onwheel={wheel}
        onkeydown={keys}
      >
        <img
          src={img.src}
          alt=""
          draggable="false"
          class="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none"
          style:width="{img.naturalWidth * scale}px"
          style:height="{img.naturalHeight * scale}px"
          style:transform="translate(calc(-50% + {crop.x}px), calc(-50% + {crop.y}px))"
        />
      </div>
      <label class="flex w-full items-center gap-3 text-sm text-muted">
        Zoom
        <input
          type="range"
          min="1"
          max="4"
          step="0.01"
          class="flex-1 accent-[var(--tm-accent)]"
          value={crop.zoom}
          oninput={(e) =>
            set({ ...crop, zoom: Number((e.currentTarget as HTMLInputElement).value) })}
        />
      </label>
    </div>
  {/if}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" loading={saving} onclick={save}>Save picture</Button>
  {/snippet}
</Dialog>
