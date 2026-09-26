/**
 * Server-only top-level platform documents (platform/db.json `schema`):
 * OAuth clients and tokens, intakes, deliveries, email threads, WhatsApp sessions.
 * Rules deny every client read/write except deliveries (owner may read).
 */
import { z } from 'zod';
import {
  BoardIdSchema,
  DeliveryChannelSchema,
  MillisSchema,
  ScopeListInputSchema,
  TicketIdSchema,
  PrincipalIdSchema,
  UidSchema,
} from '../types/index.js';

/** oauthClients/{clientId} — registered via RFC 7591 DCR (what MCP clients do). */
export const OAuthClientSchema = z.object({
  /** 'Claude', 'Cursor', 'Zapier' */
  name: z.string().min(1).max(120),
  redirectUris: z.array(z.string().url()).min(1),
  /** PKCE, no secret — every MCP client. */
  public: z.boolean(),
  secretHash: z.string().optional(),
  registeredVia: z.enum(['dcr', 'manual']),
  logoUrl: z.string().url().optional(),
  createdAt: MillisSchema,
});
export type OAuthClient = z.infer<typeof OAuthClientSchema>;

/** oauthTokens/{sha256(token)} — TTL policy on expiresAt deletes them. */
export const OAuthTokenSchema = z.object({
  kind: z.enum(['access', 'refresh', 'code']),
  uid: UidSchema,
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  /** Accepts phase-1 names on read; always the new vocabulary after parsing. */
  scopes: ScopeListInputSchema,
  /** PKCE, kind == 'code'. */
  codeChallenge: z.string().optional(),
  /** code only: the redirect_uri it was issued for (must match at /oauth/token). */
  redirectUri: z.string().optional(),
  /** access 1h, refresh 30d rotating, code 60s */
  expiresAt: MillisSchema,
  createdAt: MillisSchema.optional(),
  /** refresh / code: set when redeemed — a second use is reuse (the whole grant is revoked). */
  usedAt: MillisSchema.optional(),
});
export type OAuthToken = z.infer<typeof OAuthTokenSchema>;
export const OAUTH_TTL_MS = {
  access: 60 * 60 * 1000,
  refresh: 30 * 24 * 60 * 60 * 1000,
  code: 60 * 1000,
} as const;

/** The reference's defaults. */
export const DEFAULT_INTAKE_LIMITS = { perMin: 10, perHour: 100, perDay: 500 } as const;

/**
 * intakes/{slug} — THE REFERENCE TRACKER'S 'REPORTING API': a board made
 * addressable from a website's feedback widget by slug + secret.
 */
export const IntakeSchema = z.object({
  boardId: BoardIdSchema,
  enabled: z.boolean(),
  /** Shown once, rotated — not stored in clear. */
  secretHash: z.string().min(1),
  rotatedAt: MillisSchema,
  limits: z.object({
    perMin: z.number().int().positive(),
    perHour: z.number().int().positive(),
    perDay: z.number().int().positive(),
  }),
  allowedOrigins: z.array(z.string()),
  defaults: z.object({
    stageId: z.string().optional(),
    priorityId: z.string().optional(),
    tagIds: z.array(z.string()).optional(),
    assigneeUids: z.array(PrincipalIdSchema).optional(),
  }),
  /** Widget key → FieldDef.id */
  fieldMap: z.record(z.string(), z.string()),
  /** 'eng-bugs@in.taskmanager.app' — email-to-board */
  email: z.string().nullable(),
});
export type Intake = z.infer<typeof IntakeSchema>;

/** deliveries/{deliveryId} — 'why didn't I get the email'. TTL 30 days. */
export const DeliverySchema = z.object({
  uid: UidSchema,
  channel: DeliveryChannelSchema,
  groupKey: z.string(),
  /** What this one message carried. */
  inboxIds: z.array(z.string()),
  status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed']),
  provider: z.enum(['fcm', 'resend', 'meta', 'slack']),
  /** For status callbacks. */
  providerId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: MillisSchema,
});
export type Delivery = z.infer<typeof DeliverySchema>;

/**
 * emailThreads/{replyToken} — Reply-To: t.{replyToken}@in.taskmanager.app.
 * The reply is attributed to the person the mail was SENT to, and only if From matches.
 */
export const EmailThreadSchema = z.object({
  boardId: BoardIdSchema,
  ticketId: TicketIdSchema,
  uid: UidSchema,
  /** Every mail about a ticket replies to one phantom root. */
  messageIdHeader: z.string(),
  /** 90 days */
  expiresAt: MillisSchema,
});
export type EmailThread = z.infer<typeof EmailThreadSchema>;

/**
 * whatsappSessions/{e164}. Meta only allows free-form messages inside 24h of
 * the user's last message; outside it, only approved templates.
 */
export const WhatsappSessionSchema = z.object({
  uid: UidSchema,
  lastInboundAt: MillisSchema.nullable(),
  /** Which ticket a bare reply refers to: the last one we notified about. */
  contextTicketId: TicketIdSchema.nullable(),
  contextExpiresAt: MillisSchema,
});
export type WhatsappSession = z.infer<typeof WhatsappSessionSchema>;
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
