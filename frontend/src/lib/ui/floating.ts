/**
 * Minimal anchored positioning for popovers (Menu, DatePicker, Tooltip):
 * `position: fixed` under (or above) the anchor, flipped / clamped to stay on
 * screen, recomputed on scroll and resize.
 */
export type Placement =
  'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'top' | 'bottom' | 'right-start';

export interface FloatOptions {
  anchor: HTMLElement | null | undefined;
  placement?: Placement;
  offset?: number;
}

export function computePosition(
  a: { top: number; left: number; bottom: number; right: number; width: number; height: number },
  f: { width: number; height: number },
  vw: number,
  vh: number,
  placement: Placement,
  offset: number,
): { top: number; left: number } {
  let top: number;
  let left: number;
  const [side, align] = placement.split('-') as [string, string | undefined];
  if (side === 'right') {
    left = a.right + offset;
    top = a.top;
    if (left + f.width > vw - 4) left = a.left - f.width - offset;
  } else {
    const below = a.bottom + offset;
    const above = a.top - offset - f.height;
    top = side === 'top' ? above : below;
    if (side === 'bottom' && below + f.height > vh - 4 && above >= 4) top = above;
    if (side === 'top' && above < 4) top = below;
    left =
      align === 'end'
        ? a.right - f.width
        : align === 'start'
          ? a.left
          : a.left + a.width / 2 - f.width / 2;
  }
  left = Math.max(4, Math.min(left, vw - f.width - 4));
  top = Math.max(4, Math.min(top, vh - f.height - 4));
  return { top, left };
}

export function float(node: HTMLElement, opts: FloatOptions) {
  let o = opts;
  /*
    PORTALLED, not just `fixed`. z-index only orders an element inside its own
    stacking context, and the desktop sidebar is one (`position: sticky` makes
    one, z-index or not) that paints BELOW the main column — so the bell's
    popover, opened from the sidebar, slid under the board however high its
    z-index. Moving the panel to <body> takes it out of every such context.
    Inside a modal <dialog> (the phone drawer, a settings dialog) the target is
    that dialog instead: it is in the top layer, and <body> is beneath it.
    Both callers render ONE root element in an {#if}, so Svelte still removes
    the right node; destroy() removes it too, in case it ever does not.
  */
  const host = node.closest('dialog[open]') ?? document.body;
  if (node.parentNode !== host) host.appendChild(node);
  node.style.position = 'fixed';
  node.style.zIndex = '60';
  const update = () => {
    if (!o.anchor) return;
    const pos = computePosition(
      o.anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight },
      window.innerWidth,
      window.innerHeight,
      o.placement ?? 'bottom-start',
      o.offset ?? 6,
    );
    node.style.top = `${pos.top}px`;
    node.style.left = `${pos.left}px`;
  };
  update();
  const raf = requestAnimationFrame(update);
  window.addEventListener('scroll', update, true);
  window.addEventListener('resize', update);
  return {
    update(next: FloatOptions) {
      o = next;
      update();
    },
    destroy() {
      node.remove();
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    },
  };
}

/** Calls `fn` on a pointerdown outside `node` (and outside `also`). */
export function clickOutside(
  node: HTMLElement,
  opts: { fn: () => void; also?: HTMLElement | null },
) {
  let o = opts;
  const handler = (e: PointerEvent) => {
    const t = e.target as Node;
    if (node.contains(t) || o.also?.contains(t)) return;
    o.fn();
  };
  document.addEventListener('pointerdown', handler, true);
  return {
    update(next: typeof opts) {
      o = next;
    },
    destroy() {
      document.removeEventListener('pointerdown', handler, true);
    },
  };
}
