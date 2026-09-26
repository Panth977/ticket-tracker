/**
 * Phase 3 — TASK LISTS INSIDE THE TICKET (docs/plan/agents.html §L2), phase 15
 * (§W) inside the ticket DOCUMENT: `ticket.tasklists`, an array of
 * StoredTasklist in `position` order.
 *
 * An agent publishes its plan as a checklist and ticks it off as it works. The
 * list used to be its own document so that ticking an item did not rewrite the
 * ticket; §W reversed that trade — a card already shows '4/7', and reading it
 * from the snapshot the board already has costs nothing, while a second
 * document per list cost a listener per card.
 */
import { z } from 'zod';
import { LocalIdSchema, MillisSchema, PrincipalIdSchema } from '../types/index.js';

export const TASKLIST_TITLE_MAX = 200;
export const TASK_ITEM_TITLE_MAX = 300;
export const TASK_ITEM_NOTE_MAX = 1000;
/** ≤ 100 items per list (§L2). */
export const MAX_TASKLIST_ITEMS = 100;

/**
 *   todo     not started
 *   doing    being worked on now — highlighted with a spinner (one at a time, by convention)
 *   done     finished
 *   skipped  deliberately not done ('already covered by ENG-9')
 *   failed   tried and failed — shown red, with the note
 */
export const TASK_ITEM_STATUSES = ['todo', 'doing', 'done', 'skipped', 'failed'] as const;
export const TaskItemStatusSchema = z.enum(TASK_ITEM_STATUSES);
export type TaskItemStatus = z.infer<typeof TaskItemStatusSchema>;

/** Statuses that take an item off the 'still to do' pile. */
export const TASK_ITEM_SETTLED: readonly TaskItemStatus[] = ['done', 'skipped'];

export const TaskItemSchema = z.object({
  id: LocalIdSchema,
  title: z.string().trim().min(1).max(TASK_ITEM_TITLE_MAX),
  status: TaskItemStatusSchema,
  /** Why it failed, what was skipped, where the output went. */
  note: z.string().max(TASK_ITEM_NOTE_MAX).optional(),
  updatedAt: MillisSchema,
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

/** boards/{b}/tickets/{t}/tasklists/{listId} */
export const TasklistSchema = z.object({
  title: z.string().trim().min(1).max(TASKLIST_TITLE_MAX),
  /** Usually the agent; a person's list is owned by them. */
  owner: PrincipalIdSchema,
  items: z.array(TaskItemSchema).max(MAX_TASKLIST_ITEMS),
  /** Order among the lists on a ticket (ascending). */
  position: z.number(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
  /** The list was declared finished — a system line goes in the thread. */
  closedAt: MillisSchema.nullable(),
});
export type Tasklist = z.infer<typeof TasklistSchema>;
export type TasklistWithId = Tasklist & { id: string; boardId: string; ticketId: string };

/**
 * Phase 15 (§W): a list is stored INLINE on the ticket (`ticket.tasklists`),
 * so it carries the id its document used to be named by. Nothing else changed
 * — same fields, same rules, same '4/7'. Ticking an item now rewrites the
 * ticket document, which is the trade §W made deliberately: one write instead
 * of two documents and a second listener per card.
 */
export const StoredTasklistSchema = TasklistSchema.extend({ id: z.string().min(1).max(200) });
export type StoredTasklist = z.infer<typeof StoredTasklistSchema>;

export interface TasklistProgress {
  total: number;
  todo: number;
  doing: number;
  done: number;
  skipped: number;
  failed: number;
  /** done + skipped — what the progress bar has behind it. */
  settled: number;
  /** 0–1 (0 for an empty list). */
  fraction: number;
  /** '4 / 7' — the bar's label and the ticket card's chip (as '4/7'). */
  label: string;
  /** The item with a spinner on it, when one is running. */
  current: TaskItem | null;
}

/** The numbers the progress bar, the drawer header and the card chip show (§L2). */
export function tasklistProgress(list: Pick<Tasklist, 'items'>): TasklistProgress {
  const count = (s: TaskItemStatus) => list.items.filter((i) => i.status === s).length;
  const total = list.items.length;
  const done = count('done');
  const skipped = count('skipped');
  const settled = done + skipped;
  return {
    total,
    todo: count('todo'),
    doing: count('doing'),
    done,
    skipped,
    failed: count('failed'),
    settled,
    fraction: total === 0 ? 0 : settled / total,
    label: `${settled} / ${total}`,
    current: list.items.find((i) => i.status === 'doing') ?? null,
  };
}

/** Every item settled (or skipped) and none running — the list has nothing left. */
export const tasklistComplete = (list: Pick<Tasklist, 'items'>): boolean =>
  list.items.length > 0 &&
  list.items.every((i) => (TASK_ITEM_SETTLED as readonly string[]).includes(i.status));

/**
 * May this principal change the list (§L2: 'the owner (through its token) and
 * editors can change a list; people may also tick items by hand')? The board
 * check is in logic/can.ts (canEditTasklist), which adds scopes and role.
 */
export const isTasklistOwner = (list: Pick<Tasklist, 'owner'>, principalId: string): boolean =>
  list.owner === principalId;
