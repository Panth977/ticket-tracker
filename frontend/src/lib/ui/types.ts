import type { Indicator } from '@tm/shared';
import type { X } from 'lucide-svelte';

/** Any lucide-svelte icon component (they all share one shape). */
export type IconComponent = typeof X;

export type Size = 'sm' | 'md' | 'lg';
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface Option<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
  /**
   * indicators.html: the entity's mark. A native <select> cannot draw it in
   * the list, so Select shows the CHOSEN option's mark beside the control.
   */
  indicator?: MenuItem['indicator'];
}

export interface MenuItem {
  label: string;
  icon?: IconComponent;
  /**
   * indicators.html: an entity's mark (board, stage, artifact, memory,
   * workspace) drawn instead of `icon`. Pass the entity itself (legacy fields
   * read through indicatorOf) and a seed for the default colour.
   */
  indicator?: {
    of?: { indicator?: Indicator | null; color?: string | null; icon?: string | null } | null;
    indicator?: Indicator | null;
    seed?: string;
    /** Drawn when the entity has no mark (memories: MEMORY_DEFAULT_INDICATOR). */
    fallback?: Indicator;
  };
  /** Shown right-aligned, e.g. '⌘K'. */
  kbd?: string;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a separator ABOVE this item. */
  separator?: boolean;
}
