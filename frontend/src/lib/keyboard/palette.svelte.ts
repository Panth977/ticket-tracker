/**
 * The command palette (⌘K): "Search tickets, boards, people, commands".
 * The shell registers navigation + boards; other features plug in providers:
 *
 *   const off = palette.register({
 *     id: 'tickets', group: 'Tickets', minQuery: 1,
 *     search: async (q) => (await searchTickets(q)).map((t) => ({ id: t.id, label: `${t.key} ${t.title}`, href: routes.ticket(t.key) })),
 *   });
 *
 * Items either navigate (`href`) or `run()`.
 */
import { untrack } from 'svelte';
import type { IconComponent } from '$lib/ui/types';

export interface PaletteItem {
  id: string;
  label: string;
  /** Secondary text, right of / under the label. */
  hint?: string;
  icon?: IconComponent;
  kbd?: string;
  href?: string;
  run?: () => void | Promise<void>;
  /** Extra words that should match. */
  keywords?: string;
}

export interface PaletteProvider {
  id: string;
  group: string;
  /** Don't ask until the query has this many characters (default 0). */
  minQuery?: number;
  /** Lower sorts first (default 100). */
  order?: number;
  search(query: string): PaletteItem[] | Promise<PaletteItem[]>;
}

/** Case-insensitive token match: every word of the query appears; prefix hits rank first. */
export function matchScore(
  query: string,
  item: Pick<PaletteItem, 'label' | 'keywords' | 'hint'>,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const hay = `${item.label} ${item.keywords ?? ''} ${item.hint ?? ''}`.toLowerCase();
  const words = q.split(/\s+/);
  if (!words.every((w) => hay.includes(w))) return 0;
  const label = item.label.toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.split(/\s+/).some((w) => w.startsWith(words[0]!))) return 2;
  return 1;
}

/** Filter + rank a static list for a provider. */
export function filterItems(query: string, items: PaletteItem[]): PaletteItem[] {
  return items
    .map((it, i) => ({ it, s: matchScore(query, it), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

class Palette {
  isOpen = $state(false);
  query = $state('');
  providers = $state<PaletteProvider[]>([]);

  open(query = '') {
    this.query = query;
    this.isOpen = true;
  }
  close() {
    this.isOpen = false;
  }
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
  /** Safe to call inside an $effect: it does not subscribe the effect to the provider list. */
  register(p: PaletteProvider): () => void {
    untrack(() => {
      this.providers = [...this.providers.filter((x) => x.id !== p.id), p];
    });
    return () =>
      untrack(() => {
        this.providers = this.providers.filter((x) => x !== p);
      });
  }
}

export const palette = new Palette();
