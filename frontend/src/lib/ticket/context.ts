/**
 * The open ticket, shared with every panel of the drawer through Svelte
 * context (the drawer provides an object of GETTERS over its live state, so
 * reads stay reactive).
 */
import { getContext, setContext } from 'svelte';
import { paths, type Board, type BoardMember, type Ticket, type TicketPatch } from '@tm/shared';
import { outbox } from '$lib/api';
import { routes } from '$lib/layout/routes';
import type { WithId } from '$lib/stores';
import type { TicketPerms } from './perms';

export interface TicketCtx {
  readonly boardId: string;
  readonly ticketId: string;
  readonly ticket: WithId<Ticket>;
  readonly board: WithId<Board>;
  readonly members: WithId<BoardMember>[];
  readonly perms: TicketPerms;
  readonly me: string;
  /** The viewer's time zone. */
  readonly tz: string;
  /** Where '#KEY' should go from here (the board's ?ticket= or /t/KEY). */
  ticketHref(key: string): string;
  /** Scroll the thread to a message (Files 'jump to', pinned strip, ?m=). */
  showMessage(messageId: string): void;
  /**
   * My read pointer AS IT WAS when the ticket opened (agents.html § K ›
   * Unread): the 'New messages' / 'New' dividers sit after it. undefined =
   * still loading; null = never opened before (no divider).
   */
  readonly readSince: number | null | undefined;
}

const KEY = Symbol('ticket');

export function setTicketCtx(ctx: TicketCtx) {
  setContext(KEY, ctx);
}
/** The open ticket when inside a drawer, else null (components that also render elsewhere). */
export function maybeTicketCtx(): TicketCtx | null {
  return getContext<TicketCtx | undefined>(KEY) ?? null;
}
export function getTicketCtx(): TicketCtx {
  const c = getContext<TicketCtx | undefined>(KEY);
  if (!c) throw new Error('getTicketCtx() outside a TicketDrawer');
  return c;
}

/** A TicketPatch as an optimistic overlay: per-key merges become dotted paths. */
export function overlayOf(patch: TicketPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if ((k === 'fields' || k === 'commitments') && v && typeof v === 'object') {
      for (const [id, x] of Object.entries(v as Record<string, unknown>)) out[`${k}.${id}`] = x;
    } else out[k] = v;
  }
  return out;
}

const FIELD_WORDS: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  stageId: 'the stage',
  priorityId: 'the priority',
  assigneeUids: 'the assignees',
  tagIds: 'the tags',
  dueAt: 'the due date',
  startAt: 'the start date',
  estimate: 'the estimate',
  links: 'the links',
  commitments: 'your commitment',
  fields: 'a field',
};

/** “change the stage of ENG-4” — for toasts and the sync list. */
export function patchLabel(patch: TicketPatch, key?: string): string {
  const keys = Object.keys(patch).filter((k) => k !== 'dueAllDay');
  const what = keys.length === 1 ? (FIELD_WORDS[keys[0]!] ?? 'a field') : 'the changes';
  return `save ${what}${key ? ` of ${key}` : ''}`;
}

/**
 * ticketUpdate through the outbox (agents.html § K): the overlay shows the
 * change at once and nothing waits — this resolves true right away. A failure
 * becomes a sticky toast (Open · Cancel). `draft` + `kind` let the form that
 * made the change put it back when Open is pressed.
 */
export async function updateTicket(
  boardId: string,
  ticketId: string,
  patch: TicketPatch,
  opts: {
    ifUpdatedAt?: number;
    toast?: string | boolean;
    key?: string;
    kind?: string;
    draft?: unknown;
  } = {},
): Promise<boolean> {
  outbox.queue(
    'ticketUpdate',
    { boardId, ticketId, patch, ...(opts.ifUpdatedAt ? { ifUpdatedAt: opts.ifUpdatedAt } : {}) },
    {
      kind: opts.kind ?? 'ticket',
      label: patchLabel(patch, opts.key),
      ...(opts.key ? { openTo: routes.ticket(opts.key) } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft, persist: false } : {}),
      optimistic: { path: paths.ticket(boardId, ticketId), patch: overlayOf(patch) },
    },
  );
  return true;
}
