/**
 * Realtime Database and search-index shapes (app/db.json presence, typing,
 * tickets index; platform/db.json rateLimits).
 */
import { z } from 'zod';
import {
  BoardIdSchema,
  StageCategorySchema,
  TicketIdSchema,
  TicketStateSchema,
  PrincipalIdSchema,
  UidSchema,
} from '../types/index.js';

/**
 * presence/{boardId}/{uid} — RTDB because onDisconnect() exists here.
 * lastChanged is ServerValue.TIMESTAMP on write, a number on read.
 */
export const PresenceSchema = z.object({
  state: z.enum(['online', 'away']),
  /** 'Priya is looking at this' avatars in the drawer. */
  viewing: TicketIdSchema.nullable(),
  lastChanged: z.number(),
});
export type Presence = z.infer<typeof PresenceSchema>;

/** typing/{boardId}/{ticketId}/{uid} — shown for 5s, removed onDisconnect. */
export const TypingSchema = z.object({ at: z.number() });
export type Typing = z.infer<typeof TypingSchema>;
export const TYPING_TTL_MS = 5000;

/**
 * boardReaders/{boardId}/{uid} = true — mirror of board.readerUids, because
 * RTDB rules cannot read Firestore.
 */
export const BoardReaderSchema = z.literal(true);

/**
 * rate/{bucket}/{window} = count (Admin SDK only).
 * bucket = key:{keyId} | intake:{slug} | ip:{hash} | mcp:{grantId} | invites:{uid} | boards:{uid}
 */
export const RateCountSchema = z.number().int().nonnegative();

/**
 * Typesense collection `tickets`. Synced by onTicketWritten; messages' text
 * folded in by onMessageWritten. Searched only with a scoped key.
 */
export const TicketDocSchema = z.object({
  id: TicketIdSchema,
  boardId: BoardIdSchema,
  /** Infix-searchable: '42' finds ENG-42. */
  key: z.string(),
  title: z.string(),
  /** Description + last 20 messages, plain. */
  text: z.string(),
  stageCategory: StageCategorySchema,
  assigneeUids: z.array(PrincipalIdSchema),
  state: TicketStateSchema,
  updatedAt: z.number(),
});
export type TicketDoc = z.infer<typeof TicketDocSchema>;
export const SEARCH_COLLECTION = 'tickets';
