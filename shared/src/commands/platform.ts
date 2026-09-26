/**
 * Platform commands reached through /api (platform/backend.json), plus a few
 * EXTRA commands the Board settings screen and REST CRUD need that the spec
 * implies but does not list (marked source: 'extra').
 */
import { z } from 'zod';
import { IntegrationProviderSchema } from '../schema/board.js';
import { IntakeSchema } from '../schema/platform.js';
import {
  ADMIN_SCOPES,
  AgentIdSchema,
  BoardIdSchema,
  isAccountScope,
  MillisSchema,
  ScopeSchema,
  WebhookEventSchema,
} from '../types/index.js';
import { ApiKeyKindSchema } from '../schema/user.js';
import { defineCommand, OkResSchema, req } from './define.js';

export const grantRevoke = defineCommand({
  name: 'grantRevoke',
  source: 'platform',
  permission: 'Owner only; deletes the grant and every oauthTokens row for it.',
  errors: ['not_found'],
  req: req({ grantId: z.string().min(1) }),
  res: OkResSchema,
});

/**
 * API key v2 (agents.html §E): one board, optionally acting as one of the
 * owner's agents that is on that board.
 *
 * PHASE 10 (§R1) adds kind: 'account' — "virtual me". No boardId, always acts
 * as the caller, and may carry the account scopes. It is never created BY a
 * token: apiKeyCreate is on TOKEN_DENIED_COMMANDS, so a leaked token cannot
 * mint a longer-lived one.
 */
export const apiKeyCreate = defineCommand({
  name: 'apiKeyCreate',
  source: 'platform',
  permission:
    "Any signed-in person IN THE APP (never a token — see TOKEN_DENIED_COMMANDS), for themselves. kind 'board': boardId is a board they are on; actsAs agent means an agent THEY own, not archived, currently on that board; agent tokens cannot carry admin scopes; admin scopes need the owner to be admin there. kind 'account': no boardId, acts as them everywhere, and may carry the account scopes.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    name: z.string().trim().min(1).max(80),
    /** Default 'board' — every phase-2 caller keeps working unchanged. */
    kind: ApiKeyKindSchema.default('board'),
    /** kind 'board' only; omitted / null for an account token. */
    boardId: BoardIdSchema.nullable().optional(),
    /** Default { kind: 'user' } — the caller themselves. */
    actsAs: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('user') }).strict(),
        z.object({ kind: z.literal('agent'), id: AgentIdSchema }).strict(),
      ])
      .default({ kind: 'user' }),
    scopes: z.array(ScopeSchema).min(1),
    /** Absent / null = never expires. The form offers 30 / 90 / 365. */
    expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  }).superRefine((r, ctx) => {
    if (
      r.actsAs.kind === 'agent' &&
      r.scopes.some((s) => (ADMIN_SCOPES as readonly string[]).includes(s))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'An agent token cannot carry admin scopes',
      });
    if (r.kind === 'account') {
      if (r.boardId)
        ctx.addIssue({
          code: 'custom',
          path: ['boardId'],
          message: 'An account token has no board',
        });
      if (r.actsAs.kind !== 'user')
        ctx.addIssue({
          code: 'custom',
          path: ['actsAs'],
          message: 'An account token always acts as you',
        });
    } else {
      if (!r.boardId)
        ctx.addIssue({
          code: 'custom',
          path: ['boardId'],
          message: 'Pick the board this token works on',
        });
      if (r.scopes.some(isAccountScope))
        ctx.addIssue({
          code: 'custom',
          path: ['scopes'],
          message: 'Account-level permissions need an account token',
        });
    }
  }),
  res: z.object({
    /** 'tm_live_…' — the ONLY time it is returned. */
    key: z.string(),
    keyId: z.string(),
    /** What the list will show ('tm_live_3fa9'). */
    prefix: z.string(),
    expiresAt: MillisSchema.nullable(),
  }),
});

export const apiKeyRevoke = defineCommand({
  name: 'apiKeyRevoke',
  source: 'platform',
  permission: "Owner only; revokedAt = now, revokedReason 'owner'. Revoking twice is ok.",
  errors: ['not_found'],
  req: req({ keyId: z.string().min(1) }),
  res: OkResSchema,
});

export const webhookUpsert = defineCommand({
  name: 'webhookUpsert',
  source: 'platform',
  scopes: ['webhooks:manage'],
  permission: 'can(admin) on the board. https only; private / link-local hosts refused.',
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    boardId: BoardIdSchema,
    webhookId: z.string().min(1).optional(),
    url: z.string().url().startsWith('https://', 'https only'),
    events: z.array(WebhookEventSchema).min(1),
    active: z.boolean().optional(),
    rotateSecret: z.literal(true).optional(),
  }),
  res: z.object({
    webhookId: z.string(),
    /** Present on create and on rotateSecret — shown once. */
    secret: z.string().optional(),
    /** The 'ping' sent on save; it is saved even if the ping fails, but says so. */
    ping: z.object({ ok: z.boolean(), status: z.number().int().nullable() }).optional(),
  }),
});

export const webhookDelete = defineCommand({
  name: 'webhookDelete',
  source: 'extra',
  scopes: ['webhooks:manage'],
  permission: 'can(admin) on the board. (REST: DELETE /v1/webhooks/{id}.)',
  errors: ['forbidden', 'not_found'],
  req: req({ boardId: BoardIdSchema, webhookId: z.string().min(1) }),
  res: OkResSchema,
});

/** Intake config as the settings screen sees it — never the secret hash. */
export const IntakeConfigSchema = IntakeSchema.omit({ secretHash: true }).extend({
  slug: z.string(),
});
export type IntakeConfig = z.infer<typeof IntakeConfigSchema>;

export const intakeUpsert = defineCommand({
  name: 'intakeUpsert',
  source: 'extra',
  permission:
    'can(admin). intakes/{slug} is server-only, so Board settings › Intake reads and writes it here.',
  errors: ['forbidden', 'not_found'],
  req: req({
    boardId: BoardIdSchema,
    /** Omit every other key to just read the current config. */
    enabled: z.boolean().optional(),
    rotateSecret: z.literal(true).optional(),
    allowedOrigins: z.array(z.string().url()).optional(),
    defaults: IntakeSchema.shape.defaults.optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
  }),
  res: z.object({
    /** null when the board has no intake yet and nothing was asked to be created. */
    intake: IntakeConfigSchema.nullable(),
    /** Present when created or rotated — shown once. */
    secret: z.string().optional(),
  }),
});

export const installRemove = defineCommand({
  name: 'installRemove',
  source: 'extra',
  permission: 'can(admin). Marks the integration removed and deletes its provider token.',
  errors: ['forbidden', 'not_found'],
  req: req({ boardId: BoardIdSchema, provider: IntegrationProviderSchema }),
  res: OkResSchema,
});

/** Board settings › Integrations: what a connected provider does for THIS board. */
export const installConfigure = defineCommand({
  name: 'installConfigure',
  source: 'extra',
  permission: "can(admin). The integration must be connected (not 'removed').",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    boardId: BoardIdSchema,
    provider: IntegrationProviderSchema,
    /** github: repos linked to this board; moveOnMerge = a stage id of this board. */
    repos: z
      .array(
        z.object({
          fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          moveOnMerge: z.string().min(1).optional(),
        }),
      )
      .max(50)
      .optional(),
    /** slack: the channel this board posts to. */
    channelId: z.string().min(1).optional(),
    events: z.array(WebhookEventSchema).min(1).optional(),
  }),
  res: OkResSchema,
});
