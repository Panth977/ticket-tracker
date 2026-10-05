/** The payloads of backend/src/doors/mcpUi.ts's show_* tools (structuredContent). */
import type { PublicBoard, PublicMessage, PublicPerson, PublicTicket } from '@tm/shared';

/** mcp.ts brief(): a ticket as a row. */
export interface Brief {
  key: string;
  title: string;
  board: string;
  stage: string;
  state: string;
  priority: string | null;
  assignees: string[];
  due_at: string | null;
  updated_at: string;
  url: string;
}

export interface Abilities {
  move: boolean;
  assign: boolean;
  create: boolean;
  comment: boolean;
}

export type TicketDetail = PublicTicket & {
  watchers: PublicPerson[];
  pinned_messages: PublicMessage[];
  messages?: PublicMessage[];
  counts: { messages: number; files: number };
};

export type View =
  | { view: 'board'; board: PublicBoard; tickets: Brief[]; truncated: boolean; can: Abilities }
  | { view: 'ticket'; ticket: TicketDetail; board: PublicBoard; me: string; can: Abilities }
  | { view: 'mywork'; now: string; tickets: Brief[]; overdue: string[]; can: Abilities };
