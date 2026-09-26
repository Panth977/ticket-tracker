/**
 * The render half of a TipTap suggestion (@ people, # tickets, / commands):
 * one SuggestionMenu mounted into <body> while the picker is active, fed by a
 * shared $state. Arrow keys move, Enter / Tab pick, Escape closes.
 */
import { mount, unmount } from 'svelte';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import SuggestionMenu from './SuggestionMenu.svelte';

export interface SuggestItem {
  id: string;
  kind: 'person' | 'ticket' | 'command';
  label: string;
  detail?: string;
  /** person */
  uid?: string;
  avatarUrl?: string | null;
  /** person: an agent's icon id (drawn when there is no picture). */
  icon?: string | null;
  /** ticket */
  ticketId?: string;
  key?: string;
}

export interface SuggestState {
  items: SuggestItem[];
  index: number;
  rect: DOMRect | null;
  loading: boolean;
  empty: string;
  label: string;
}

export function suggestionRenderer(label: string, empty: string) {
  return () => {
    const s: SuggestState = $state({
      items: [],
      index: 0,
      rect: null,
      loading: true,
      empty,
      label,
    });
    let cmp: ReturnType<typeof mount> | null = null;
    let pick: ((item: SuggestItem) => void) | null = null;

    const sync = (p: SuggestionProps<SuggestItem, SuggestItem>) => {
      s.items = p.items;
      s.loading = false;
      if (s.index >= p.items.length) s.index = 0;
      s.rect = p.clientRect?.() ?? null;
      pick = (item) => p.command(item);
    };

    return {
      onBeforeStart() {
        s.loading = true;
      },
      onStart(p: SuggestionProps<SuggestItem, SuggestItem>) {
        s.index = 0;
        sync(p);
        cmp = mount(SuggestionMenu, {
          target: document.body,
          props: { state: s, onpick: (i: SuggestItem) => pick?.(i) },
        });
      },
      onUpdate(p: SuggestionProps<SuggestItem, SuggestItem>) {
        sync(p);
      },
      onKeyDown({ event }: SuggestionKeyDownProps): boolean {
        // Dismissed with Escape: keys belong to the editor again until the next trigger.
        if (!cmp) return false;
        const n = s.items.length;
        if (event.key === 'ArrowDown') {
          if (n) s.index = (s.index + 1) % n;
          return true;
        }
        if (event.key === 'ArrowUp') {
          if (n) s.index = (s.index - 1 + n) % n;
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = s.items[s.index];
          if (!item) return false;
          pick?.(item);
          return true;
        }
        if (event.key === 'Escape') {
          if (cmp) {
            void unmount(cmp);
            cmp = null;
          }
          return true;
        }
        return false;
      },
      onExit() {
        if (cmp) void unmount(cmp);
        cmp = null;
      },
    };
  };
}
