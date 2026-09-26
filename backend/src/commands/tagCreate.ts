/**
 * tagCreate — can(edit): editors make tags on the fly from the picker.
 * Renaming, recolouring and deleting tags stays with admins (boardUpdate).
 * The same name in any case returns the existing tag (the reference's rule).
 */
import type { Option } from '@tm/shared';
import { runTx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertActive, boardRef, loadBoard } from './boardShared.js';

export default defineCommand('tagCreate', async (ctx, { boardId, name, color }) => {
  const tag = await runTx(async (tx) => {
    const board = await loadBoard(tx, boardId, ctx, 'edit');
    assertActive(board);
    const lower = name.toLocaleLowerCase();
    const same = board.tags.find((t) => t.name.toLocaleLowerCase() === lower);
    if (same) return same;
    const created: Option = {
      id: ctx.ids.shortId(),
      name,
      position: board.tags.reduce((m, t) => Math.max(m, t.position), -1) + 1,
      ...(color ? { color } : {}),
    };
    tx.update(boardRef(boardId), { tags: [...board.tags, created] });
    return created;
  });
  return { tag };
});
