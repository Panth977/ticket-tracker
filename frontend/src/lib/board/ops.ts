/**
 * Ticket writes from the board views, through the outbox (agents.html § K).
 * Every one is a single ticketUpdate with an optimistic overlay on that one
 * document, so a drag feels instant; nothing waits for the server. A refusal
 * leaves the change showing with a sticky toast (Open · Cancel — Cancel snaps
 * it back).
 *
 * A stage whose `requires` fields are missing answers 422 { missing, stageId };
 * instead of a toast, the board opens the requires prompt (BoardState.requires)
 * and retries the same move with the fields filled in.
 */
import { paths, type BulkAction, type TicketPatch } from '@tm/shared';
import { outbox } from '$lib/api';
import { routes } from '$lib/layout/routes';
import { patchLabel } from '$lib/ticket/context';
import { toast } from '$lib/ui/toast.svelte';
import { overlayFor } from '$lib/views/move';
import type { BoardState, BoardTicket } from './context.svelte';

export interface UpdateOpts {
  rank?: { after?: string; before?: string };
  /** Local rank for the overlay while the server computes the real one. */
  localRank?: string;
  /** Headline for a failure toast. */
  failure?: string;
}

/** Extra overlay keys a patch implies (the stage's category is denormalised on the ticket). */
function implied(bs: BoardState, patch: TicketPatch, localRank?: string): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (patch.stageId) {
    const st = bs.stage(patch.stageId);
    if (st) extra.stageCategory = st.category;
  }
  if (localRank) extra.rank = localRank;
  return extra;
}

export async function updateTicket(
  bs: BoardState,
  t: BoardTicket,
  patch: TicketPatch,
  opts: UpdateOpts = {},
): Promise<boolean> {
  const board = bs.board;
  if (!board) return false;
  if (bs.pending.has(t.id)) {
    toast.info(`${t.title} is still being created`, 'Change it once it has its key.');
    return false;
  }
  outbox.queue(
    'ticketUpdate',
    { boardId: board.id, ticketId: t.id, patch, ...(opts.rank ? { rank: opts.rank } : {}) },
    {
      kind: 'ticket',
      label: opts.failure ?? patchLabel(patch, t.key),
      openTo: routes.board(board.key, undefined, t.key),
      optimistic: {
        path: paths.ticket(board.id, t.id),
        patch: overlayFor(patch, implied(bs, patch, opts.localRank)),
      },
      // The target stage requires fields: snap back and ask for them (the prompt retries the move).
      onError: (e) => {
        if (e.code !== 'unprocessable' || !Array.isArray(e.details?.missing)) return false;
        bs.requires = {
          ticket: t,
          stageId: String(e.details.stageId ?? patch.stageId ?? t.stageId),
          missing: e.details.missing as string[],
          patch,
          rank: opts.rank,
        };
        return true;
      },
    },
  );
  return true;
}

/** Bulk action over the selection; reports skipped tickets (a commenter's grant). */
export async function bulk(bs: BoardState, ticketIds: string[], action: BulkAction): Promise<void> {
  const board = bs.board;
  if (!board || ticketIds.length === 0) return;
  const n = ticketIds.length;
  outbox.queue(
    'ticketBulk',
    { boardId: board.id, ticketIds, action },
    {
      kind: 'ticket',
      label: `change ${n} ticket${n === 1 ? '' : 's'}`,
      onSuccess: (res) => {
        const skipped = res.skipped.length;
        toast.success(
          `Updated ${res.updated} ticket${res.updated === 1 ? '' : 's'}`,
          skipped ? `${skipped} skipped — outside what you may change` : undefined,
        );
      },
    },
  );
}
