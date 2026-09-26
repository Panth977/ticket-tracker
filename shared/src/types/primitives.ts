/**
 * Primitive identifiers and scalars (docs/data/app/db.json `types`).
 *
 * Convention for the whole package: every shape is a zod schema named
 * `XSchema` with an inferred TS type `X` beside it.
 */
import { z } from 'zod';

/**
 * The Firebase Auth uid — the ONLY way a person is stored anywhere
 * (assignees, access, mentions, authors, read pointers, prefs). Email is
 * shown, never stored as a key.
 */
export const UidSchema = z.string().min(1).max(128);
export type Uid = z.infer<typeof UidSchema>;

/**
 * PHASE 2 — PRINCIPALS (docs/plan/agents.html §A). Anyone who can appear on a
 * ticket is a principal: a person (their Firebase uid) or an AGENT, whose id is
 * 'ag_' + 16 [A-Za-z0-9]. Both live in the same fields (board.access keys,
 * members/{id}, assigneeUids, watcherUids, mention nodes, message.authorUid,
 * activity.actor); the PREFIX tells them apart. Agents never sign in to
 * Firebase, so they never appear in readerUids / editorUids or in rules.
 */
export const AGENT_ID_PREFIX = 'ag_';
export const AGENT_ID_RE = /^ag_[A-Za-z0-9]{16}$/;
export const AgentIdSchema = z.string().regex(AGENT_ID_RE, "Agent id: 'ag_' + 16 letters/digits");
export type AgentId = z.infer<typeof AgentIdSchema>;

/** A uid or an agent id. Same validation as a uid; use isAgentId() to tell them apart. */
export const PrincipalIdSchema = UidSchema;
export type PrincipalId = Uid | AgentId;

export const PRINCIPAL_KINDS = ['user', 'agent'] as const;
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

/** { kind, id } — how tokens (ApiKey.actsAs) and the API name a principal. */
export const PrincipalRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: UidSchema }),
  z.object({ kind: z.literal('agent'), id: AgentIdSchema }),
]);
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;

export const isAgentId = (id: string | null | undefined): id is AgentId =>
  !!id && AGENT_ID_RE.test(id);
export const principalKind = (id: string): PrincipalKind => (isAgentId(id) ? 'agent' : 'user');

const AGENT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * A new agent id. `random` returns [0, 1) — pass a CSPRNG-backed source on the
 * server; defaults to Math.random (ids are not secrets, only unique).
 */
export function newAgentId(random: () => number = Math.random): AgentId {
  let s = AGENT_ID_PREFIX;
  for (let i = 0; i < 16; i++)
    s += AGENT_ID_ALPHABET[Math.floor(random() * AGENT_ID_ALPHABET.length)]!;
  return s;
}

/** Generated, never shown. */
export const BoardIdSchema = z.string().min(1).max(128);
export type BoardId = z.infer<typeof BoardIdSchema>;

/** Generated and IMMUTABLE — the ticket's identity, whatever its key reads. */
export const TicketIdSchema = z.string().min(1).max(128);
export type TicketId = z.infer<typeof TicketIdSchema>;

/** 'ENG' — claimed app-wide in boardKeys/{key}, first come first served. */
export const BOARD_KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
export const BoardKeySchema = z
  .string()
  .regex(BOARD_KEY_RE, 'Board key: 2–6 chars, A–Z then A–Z/0–9');
export type BoardKey = z.infer<typeof BoardKeySchema>;

/** 'ENG-42' — `${BoardKey}-${number}`; allocated once, never reissued. */
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9]{1,5}-[1-9][0-9]*$/;
export type TicketKey = `${string}-${number}`;
export const TicketKeySchema = z
  .string()
  .regex(TICKET_KEY_RE, 'Ticket key: BOARDKEY-number')
  .transform((s) => s as TicketKey);

/**
 * Epoch milliseconds, UTC. Dates the USER picks (due, start, date fields)
 * are Millis plus an allDay flag.
 */
export const MillisSchema = z.number().int().nonnegative();
export type Millis = z.infer<typeof MillisSchema>;

/** Short board-local ids (stages, options): 7-char base36 in practice. */
export const LocalIdSchema = z.string().min(1).max(64);

/** A hex colour or a named palette token. */
export const ColorSchema = z.string().min(1).max(32);

export const EmailSchema = z.string().email().max(320);

/** Storage object path (never a download URL). */
export const StoragePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/^https?:/i.test(p), {
    message: 'A Storage path, never a URL',
  });
