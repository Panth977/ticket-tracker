/**
 * Notification copy: the one-line summary an inbox row, a push body, a mail
 * and a WhatsApp message all share ('moved to QA', 'mentioned you: …').
 * Pure — the router hands in the names it already loaded.
 */
import type { NotifyEvent } from '@tm/shared';

export interface SummaryInput {
  event: NotifyEvent;
  /** Stage names by id (for 'stage' / 'updated'). */
  stageName?: (id: string) => string | undefined;
  changes?: Record<string, { from: unknown; to: unknown }> | undefined;
  /** Plain text of the message behind 'comment' / 'mentioned'. */
  messageText?: string | undefined;
  ticketTitle?: string | null | undefined;
  ticketState?: string | undefined;
  toStageId?: string | undefined;
  boardName?: string | undefined;
  /** Explicit recipients were named (assigned: 'assigned you'). */
  direct?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  stageId: 'the stage',
  priorityId: 'the priority',
  tagIds: 'tags',
  assigneeUids: 'assignees',
  startAt: 'the start date',
  dueAt: 'the due date',
  dueAllDay: 'the due date',
  estimate: 'the estimate',
  links: 'links',
  commitments: 'commitments',
  state: 'the state',
};

/** 'a, b and c' */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function summarize(i: SummaryInput): string {
  const quote = i.messageText ? `: “${snippet(i.messageText, 120)}”` : '';
  switch (i.event) {
    case 'mentioned':
      return `mentioned you${quote}`;
    case 'comment':
      return `commented${quote}`;
    case 'assigned':
      return i.direct === false ? 'changed the assignees' : 'assigned you';
    case 'created':
      return i.ticketTitle ? `created “${snippet(i.ticketTitle, 80)}”` : 'created a ticket';
    case 'stage': {
      const to = i.toStageId ?? (i.changes?.stageId?.to as string | undefined);
      const name = to ? i.stageName?.(to) : undefined;
      return name ? `moved to ${name}` : 'moved this';
    }
    case 'updated': {
      const keys = Object.keys(i.changes ?? {});
      const labels = [
        ...new Set(keys.map((k) => (k.startsWith('fields.') ? 'a field' : (FIELD_LABELS[k] ?? k)))),
      ];
      return labels.length
        ? `changed ${joinWords(labels.slice(0, 3))}${labels.length > 3 ? ' and more' : ''}`
        : 'updated this';
    }
    case 'state':
      return i.ticketState === 'archived' ? 'archived this' : 'restored this';
    case 'dueSoon':
      return 'is due soon';
    case 'overdue':
      return 'is overdue';
    case 'invited':
      return i.boardName ? `invited you to ${i.boardName}` : 'invited you to a board';
    // Phase 3 (§L1): `messageText` is the question message's body text, which
    // holds its title — 'asked: “Which database should the report use?”'.
    case 'question':
      return i.messageText ? `asked${quote}` : 'asked you a question';
    // Phase 3 (§L3): the sweep writes the whole line itself (it knows the agent
    // and how long it has been quiet); this is the fallback.
    case 'agentSilence':
      return 'stopped reporting';
  }
}

/** Per-event presentation for mail and push: the kicker above the title and an accent colour. */
export const EVENT_STYLE: Record<NotifyEvent, { kicker: string; accent: string }> = {
  assigned: { kicker: 'Assigned to you', accent: '#2563eb' },
  mentioned: { kicker: 'You were mentioned', accent: '#7c3aed' },
  comment: { kicker: 'New comment', accent: '#0f766e' },
  stage: { kicker: 'Moved', accent: '#0891b2' },
  updated: { kicker: 'Updated', accent: '#475569' },
  created: { kicker: 'New ticket', accent: '#16a34a' },
  dueSoon: { kicker: 'Due soon', accent: '#d97706' },
  overdue: { kicker: 'Overdue', accent: '#dc2626' },
  state: { kicker: 'Status changed', accent: '#64748b' },
  invited: { kicker: 'Invitation', accent: '#db2777' },
  // Phase 3 (§L1): somebody is blocked until this is answered — loud on purpose.
  question: { kicker: 'A question for you', accent: '#9333ea' },
  // Phase 3 (§L3): red, like the dot on the card.
  agentSilence: { kicker: 'Your agent went quiet', accent: '#dc2626' },
};
