/**
 * Board settings: EACH SECTION SAVES ITSELF (app.json › Board settings — the
 * reference saved everything with one wholesale PATCH and two admins saving
 * at once lost a section). A section edits a local draft of just its slice of
 * the board and sends boardUpdate with just that key.
 *
 * useDraft follows the live board while the draft is clean; once I have edits
 * it keeps them (the baseline still moves, so 'dirty' stays honest).
 */
import { getContext, setContext, untrack } from 'svelte';
import type { Board, BoardRole } from '@tm/shared';
import type { WithId } from '$lib/stores';
import { outbox } from '$lib/api';
import { settingsKind } from './save';

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface Draft<T> {
  value: T;
  readonly base: T;
  readonly dirty: boolean;
  reset(): void;
  /** After a successful save: what I sent is the new baseline. */
  commit(): void;
}

export function useDraft<T>(source: () => T): Draft<T> {
  let base = $state(clone(untrack(source)));
  let value = $state(clone(untrack(source)));
  $effect(() => {
    const s = source();
    untrack(() => {
      if (same(value, base)) value = clone(s);
      base = clone(s);
    });
  });
  return {
    get value() {
      return value;
    },
    set value(v: T) {
      value = v;
    },
    get base() {
      return base;
    },
    get dirty() {
      return !same(value, base);
    },
    reset() {
      value = clone(base);
    },
    commit() {
      base = clone(value);
    },
  };
}

/** What every section reads: the live board and who I am on it. */
export interface SettingsCtx {
  readonly board: WithId<Board>;
  readonly me: string;
  readonly role: BoardRole | null;
  readonly isAdmin: boolean;
  readonly readOnly: boolean;
  /** The board's people, for pickers (members/, by name). */
  readonly members: { uid: string; name: string; email: string; role: BoardRole }[];
}
const KEY = Symbol('board-settings');
export const provideSettings = (c: SettingsCtx) => setContext(KEY, c);
export function useSettings(): SettingsCtx {
  const c = getContext<SettingsCtx | undefined>(KEY);
  if (!c) throw new Error('useSettings() outside board settings');
  return c;
}

/** A board-local id for a new stage / option: 7 chars base36. */
export function localId(taken: Iterable<string> = []): string {
  const used = [...taken];
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(7));
    const id = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
    if (!used.includes(id)) return id;
  }
}

/** A custom field id: 'f_' + 6 chars (FIELD_ID_RE). */
export function fieldId(taken: Iterable<string> = []): string {
  const used = [...taken];
  for (;;) {
    const id = `f_${localId().slice(0, 6)}`;
    if (!used.includes(id)) return id;
  }
}

/** Positions 0..n-1 in the order given. */
export const renumber = <X extends { position: number }>(xs: X[]): X[] =>
  xs.map((x, i) => ({ ...x, position: i }));
export const byPosition = <X extends { position: number }>(xs: readonly X[]): X[] =>
  [...xs].sort((a, b) => a.position - b.position);

/**
 * A failed save's Open lands on its section: put the edited values back in
 * the draft (and drop the failed entry — saving again makes a new one).
 */
export function useRestore<T>(section: () => string, draft: Draft<T>) {
  $effect(() => {
    void outbox.opening;
    const kind = settingsKind(section());
    untrack(() => {
      const e = outbox.take(kind);
      if (!e) return;
      outbox.cancel(e.id);
      const v = (e.draft as { value?: T } | undefined)?.value;
      if (v !== undefined) draft.value = clone(v);
    });
  });
}
