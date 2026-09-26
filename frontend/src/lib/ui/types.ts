import type { X } from 'lucide-svelte';

/** Any lucide-svelte icon component (they all share one shape). */
export type IconComponent = typeof X;

export type Size = 'sm' | 'md' | 'lg';
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface Option<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface MenuItem {
  label: string;
  icon?: IconComponent;
  /** Shown right-aligned, e.g. '⌘K'. */
  kbd?: string;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator ABOVE this item. */
  separator?: boolean;
}
