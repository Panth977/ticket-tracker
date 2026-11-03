/**
 * The board script's host for a component that is not under the board page
 * (the ticket drawer's composer): the board's saved script (or its generated
 * one), acquired while the component lives. Call during component init.
 */
import { onDestroy } from 'svelte';
import type { Board } from '@tm/shared';
import {
  acquireScriptHost,
  effectiveBoardScript,
  releaseScriptHost,
  savedScript,
  type BoardScriptHost,
  type ScriptMe,
} from './script';

export function useScriptHost(get: () => { board: Board & { id: string }; me: ScriptMe }) {
  const saved = savedScript(get().board.id);
  const s = $state<{ host: BoardScriptHost | null }>({ host: null });
  let held: { h: BoardScriptHost; boardId: string; me: ScriptMe } | null = null;
  const off = saved.subscribe((v) => {
    if (v.loading) return;
    const { board, me } = get();
    const h = acquireScriptHost(effectiveBoardScript(board, v.data).code, board, me);
    const prev = held;
    held = { h, boardId: board.id, me };
    s.host = h;
    if (prev) releaseScriptHost(prev.h, prev.boardId, prev.me);
  });
  onDestroy(() => {
    off();
    if (held) releaseScriptHost(held.h, held.boardId, held.me);
  });
  return s;
}
