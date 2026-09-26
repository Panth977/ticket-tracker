/**
 * Motion helpers (agents.html § K › Motion). Durations go through motion(),
 * which returns 0 when the user prefers reduced motion — Svelte transitions
 * then just appear. CSS animations are covered by the reduced-motion block
 * in app.css.
 */
import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

export function reducedMotion(): boolean {
  try {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/** `ms`, or 0 under prefers-reduced-motion. */
export function motion(ms: number): number {
  return reducedMotion() ? 0 : ms;
}

/** Fade + a slight scale (dialogs, menus, popovers, new cards). */
export function pop(
  _node: Element,
  { duration = 150, start = 0.97, delay = 0 } = {},
): TransitionConfig {
  const d = motion(duration);
  return {
    duration: d,
    delay: d ? delay : 0,
    easing: cubicOut,
    css: (t) => `opacity:${t};transform:scale(${start + (1 - start) * t})`,
  };
}

/** A new message: rises 6 px as it fades in. */
export function rise(_node: Element, { duration = 180, y = 6 } = {}): TransitionConfig {
  const d = motion(duration);
  return {
    duration: d,
    easing: cubicOut,
    css: (t) => `opacity:${t};transform:translateY(${(1 - t) * y}px)`,
  };
}

/** A removed card: fades while its height collapses, so the column closes up smoothly. */
export function collapse(node: Element, { duration = 160 } = {}): TransitionConfig {
  const d = motion(duration);
  const h = (node as HTMLElement).offsetHeight;
  return {
    duration: d,
    easing: cubicOut,
    css: (t) =>
      `opacity:${t};height:${t * h}px;overflow:hidden;transform:scale(${0.97 + 0.03 * t})`,
  };
}

/** The ticket drawer: translateX 100% → 0, ~220 ms ease-out. */
export function slideFromRight(_node: Element, { duration = 220 } = {}): TransitionConfig {
  const d = motion(duration);
  return { duration: d, easing: cubicOut, css: (t) => `transform:translateX(${(1 - t) * 100}%)` };
}
