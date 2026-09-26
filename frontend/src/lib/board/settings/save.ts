/**
 * boardUpdate for one settings section, through the outbox (agents.html § K):
 * the board shows the new settings at once (an optimistic overlay on the
 * board document) and the section's draft becomes its baseline — nothing
 * waits. A failure is a sticky toast whose Open comes back to this section
 * with the edited values (useRestore), and whose Cancel rolls back.
 *
 * Removing a stage / priority that still has tickets answers 409
 * { stageId | priorityId, count }: the save is rolled back and `onNeeds`
 * asks where those tickets go; the caller saves again with the remap (the
 * server moves them).
 */
import { paths, type BoardPatch } from '@tm/shared';
import { outbox } from '$lib/api';
import { toast } from '$lib/ui/toast.svelte';

export type Remap = { stages?: Record<string, string>; priorities?: Record<string, string> };
export type Needs = { kind: 'stage' | 'priority'; id: string; count: number };

export interface SaveOpts {
  /** The settings section (its Open goes back there): 'stages', 'fields', … */
  section: string;
  /** Where the section lives. */
  openTo: string;
  /** The section's edited value (restored on Open). */
  value: unknown;
  /** The server needs a remap before it can remove a stage / priority. */
  onNeeds?: (needs: Needs) => void;
}

/** The outbox kind of a settings section's saves. */
export const settingsKind = (section: string) => `settings:${section}`;

export function saveBoard(
  boardId: string,
  patch: BoardPatch,
  remap: Remap | undefined,
  what: string,
  opts: SaveOpts,
): void {
  outbox.queue(
    'boardUpdate',
    { boardId, patch, ...(remap ? { remap } : {}) },
    {
      kind: settingsKind(opts.section),
      label: `save ${what}`,
      openTo: opts.openTo,
      draft: { value: opts.value },
      // Closures (onNeeds) do not survive a reload; neither should this.
      persist: false,
      boardId,
      optimistic: { path: paths.board(boardId), patch: patch as Record<string, unknown> },
      onSuccess: () => toast.success(`Saved ${what}`),
      onError: (e) => {
        if (e.code !== 'conflict' || !opts.onNeeds) return false;
        const d = e.details ?? {};
        if (typeof d.stageId === 'string')
          opts.onNeeds({ kind: 'stage', id: d.stageId, count: Number(d.count ?? 0) });
        else if (typeof d.priorityId === 'string')
          opts.onNeeds({ kind: 'priority', id: d.priorityId, count: Number(d.count ?? 0) });
        else return false;
        return true;
      },
    },
  );
}
