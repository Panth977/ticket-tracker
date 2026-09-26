/**
 * RichText (docs/data/app/db.json `types.RichText`).
 *
 * The node schema here is STRUCTURAL only: the allow-list of node and mark
 * types, and the attrs a mention / ticketRef carry, are validated by the
 * TipTap schema in shared/src/logic (parseRichText / validateDoc).
 */
import { z } from 'zod';
import { PrincipalIdSchema, TicketIdSchema } from './primitives.js';

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown> | undefined;
}

/** A ProseMirror / TipTap JSON node. */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  content?: PMNode[] | undefined;
  marks?: PMMark[] | undefined;
  text?: string | undefined;
}

export const PMMarkSchema: z.ZodType<PMMark> = z.object({
  type: z.string().min(1),
  attrs: z.record(z.unknown()).optional(),
});

export const PMNodeSchema: z.ZodType<PMNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.unknown()).optional(),
    content: z.array(PMNodeSchema).optional(),
    marks: z.array(PMMarkSchema).optional(),
    text: z.string().optional(),
  }),
);

/** What the editor edits and what every command accepts as a body. */
export const RichTextDocSchema = z.object({
  type: z.literal('doc'),
  content: z.array(PMNodeSchema),
});
export type RichTextDoc = z.infer<typeof RichTextDocSchema>;

/**
 * A stored rich text: the doc plus fields DERIVED ON THE SERVER, never
 * trusted from the client. A mention node is { type: 'mention', attrs: { uid } }
 * and renders the person's current name; a ref is { type: 'ticketRef', attrs: { ticketId, key } }.
 */
export const RichTextSchema = z.object({
  doc: RichTextDocSchema,
  /** Plain text — email, WhatsApp, search, previews. */
  text: z.string(),
  /** Every mention node in doc. */
  /** Principals: people and agents. */
  mentions: z.array(PrincipalIdSchema),
  /** Every #ticket node in doc. */
  refs: z.array(TicketIdSchema),
});
export type RichText = z.infer<typeof RichTextSchema>;

/** Mention node attrs, as stored in the doc. */
/** `uid` holds a PRINCIPAL id (a person's uid or an agent's 'ag_…'); the name is kept for compatibility. */
export const MentionAttrsSchema = z.object({ uid: PrincipalIdSchema });
/** ticketRef node attrs: the id is the link, the key is only a render hint. */
export const TicketRefAttrsSchema = z.object({
  ticketId: TicketIdSchema,
  key: z.string().optional(),
});

export const EMPTY_DOC: RichTextDoc = { type: 'doc', content: [] };
