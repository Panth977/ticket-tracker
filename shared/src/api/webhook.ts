/**
 * Webhook envelopes with their typed `data` (the PUBLIC shapes, never raw docs).
 */
import { z } from 'zod';
import { envelopeSchema, type WebhookEvent } from '../types/index.js';
import {
  PublicBoardSchema,
  PublicMemberSchema,
  PublicMessageSchema,
  PublicTicketSchema,
} from './public.js';

/** What `data` carries for each event. */
export const WEBHOOK_EVENT_DATA = {
  'ticket.created': PublicTicketSchema,
  'ticket.updated': PublicTicketSchema.extend({ changes: z.array(z.string()).optional() }),
  'ticket.moved': PublicTicketSchema.extend({
    from_stage: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
  'ticket.state': PublicTicketSchema,
  'ticket.deleted': z.object({ id: z.string(), key: z.string() }),
  'message.created': PublicMessageSchema,
  'message.pinned': PublicMessageSchema,
  'board.updated': PublicBoardSchema,
  'member.joined': PublicMemberSchema,
} as const satisfies Record<WebhookEvent, z.ZodTypeAny>;

export type WebhookData<E extends WebhookEvent> = z.infer<(typeof WEBHOOK_EVENT_DATA)[E]>;

/** Validate a whole envelope against its event's data schema. */
export function envelopeSchemaFor<E extends WebhookEvent>(event: E) {
  return envelopeSchema(WEBHOOK_EVENT_DATA[event]).extend({ type: z.literal(event) });
}

/** The 'ping' sent when a webhook is saved (not a subscribable event). */
export const PingEnvelopeSchema = envelopeSchema(z.object({ webhook_id: z.string() })).extend({
  type: z.literal('ping'),
});

/** `t=<unix>,v1=<hex>` — HMAC_SHA256(secret, `${t}.${body}`); computed by the backend with node:crypto. */
export function formatSignatureHeader(unixSeconds: number, hexHmac: string): string {
  return `t=${unixSeconds},v1=${hexHmac}`;
}
export function parseSignatureHeader(h: string): { t: number; v1: string } | null {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(h.trim());
  return m ? { t: Number(m[1]), v1: m[2]! } : null;
}
export const signaturePayload = (unixSeconds: number, body: string): string =>
  `${unixSeconds}.${body}`;
