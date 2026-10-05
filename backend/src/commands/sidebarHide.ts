/**
 * sidebarHide (agents.html §AB) — hide a board or an artifact from the
 * sidebar's root lists, or show it again. Only the caller's own
 * users/{actor}/ui/sidebar changes: the board or artifact is not archived,
 * and the "All" pages and workspaces still show it. Hiding something the
 * caller cannot open is refused; showing again never is (it cleans up).
 */
import { EMPTY_SIDEBAR_PREFS, paths, type SidebarPrefs } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { assertReachable, personOnly } from './workspaceShared.js';

export default defineCommand(
  'sidebarHide',
  async (ctx, { boardId, artifactId, memoryId, hidden }) => {
    personOnly(ctx);
    await runTx(async (tx) => {
      const ref = typedDoc('sidebarPrefs', paths.sidebarPrefs(ctx.actor));
      const cur: SidebarPrefs = (await txGet(tx, ref)) ?? {
        ...EMPTY_SIDEBAR_PREFS,
        updatedAt: ctx.now,
      };
      if (hidden)
        await assertReachable(tx, ctx, {
          ...(boardId ? { boardIds: [boardId] } : {}),
          ...(artifactId ? { artifactIds: [artifactId] } : {}),
          ...(memoryId ? { memoryIds: [memoryId] } : {}),
        });
      const flip = (list: string[], id: string | undefined) =>
        !id ? list : hidden ? [...new Set([...list, id])] : list.filter((x) => x !== id);
      tx.set(ref, {
        hiddenBoardIds: flip(cur.hiddenBoardIds, boardId),
        hiddenArtifactIds: flip(cur.hiddenArtifactIds, artifactId),
        hiddenMemoryIds: flip(cur.hiddenMemoryIds ?? [], memoryId),
        updatedAt: ctx.now,
      });
    });
    return { ok: true as const };
  },
);
