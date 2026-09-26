/**
 * Per-person commands: search key, profile, WhatsApp link, account delete / export.
 */
import { z } from 'zod';
import { ThemeSchema, UserNotifySchema } from '../schema/user.js';
import { ChannelMatrixSchema, MillisSchema, StoragePathSchema } from '../types/index.js';
import { ClientIdSchema, defineCommand, OkResSchema, req } from './define.js';

export const searchKey = defineCommand({
  name: 'searchKey',
  source: 'app',
  permission:
    'Any signed-in user; the key is scoped to boards where readerUids contains them, valid 1h.',
  errors: ['unavailable'],
  req: req({}),
  res: z.object({
    key: z.string(),
    /** Typesense host URL the browser searches directly. */
    host: z.string(),
    expiresAt: MillisSchema,
  }),
});

export const profileUpdate = defineCommand({
  name: 'profileUpdate',
  source: 'app',
  permission:
    'Any signed-in user, their own profile. avatarPath must be under users/{actor}/avatar/, exist, and be an image.',
  errors: ['invalid', 'not_found'],
  req: req({
    /** Display name, 1–60 chars. */
    name: z.string().trim().min(1).max(60).optional(),
    /** Just uploaded to users/{uid}/avatar/…; null removes it. */
    avatarPath: StoragePathSchema.nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(1).max(35).optional(),
    theme: ThemeSchema.optional(),
    /**
     * Account › Notifications (the screen calls profileUpdate): channels are
     * merged per event; other keys replace.
     */
    notify: UserNotifySchema.extend({ channels: ChannelMatrixSchema.partial() })
      .partial()
      .strict()
      .optional(),
    /** Turn WhatsApp notifications off/on for an already-verified number. */
    whatsappOptIn: z.boolean().optional(),
  }),
  res: OkResSchema,
});

export const whatsappLink = defineCommand({
  name: 'whatsappLink',
  source: 'app',
  permission: 'Any signed-in user, their own number. verify: 5 attempts, code valid 10 min.',
  errors: ['invalid', 'rate_limited', 'gone', 'forbidden'],
  req: z.discriminatedUnion('step', [
    z
      .object({
        step: z.literal('send'),
        /** E.164, '+919812345678' */
        number: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number, e.g. +919812345678'),
        clientId: ClientIdSchema.optional(),
      })
      .strict(),
    z
      .object({
        step: z.literal('verify'),
        code: z.string().regex(/^\d{6}$/),
        clientId: ClientIdSchema.optional(),
      })
      .strict(),
  ]),
  res: z.object({ ok: z.literal(true) }),
});

export const accountDelete = defineCommand({
  name: 'accountDelete',
  source: 'app',
  permission:
    'Themselves, after a recent login. The only admin of a board with other people → 409 naming the boards.',
  errors: ['conflict', 'forbidden'],
  req: req({ confirm: z.literal('DELETE'), recentLogin: z.literal(true) }),
  res: OkResSchema,
});

export const accountExport = defineCommand({
  name: 'accountExport',
  source: 'app',
  permission: 'Themselves. Queued; a signed URL (7 days) is emailed when ready.',
  errors: ['rate_limited'],
  req: req({}),
  res: z.object({ jobId: z.string() }),
});

/** Account › Security › 'Sign out everywhere' (extra: the screen implies it, the spec lists no command). */
export const sessionRevokeAll = defineCommand({
  name: 'sessionRevokeAll',
  source: 'extra',
  permission:
    'Themselves. Revokes every refresh token of the account; this browser signs in again too.',
  errors: [],
  req: req({}),
  res: OkResSchema,
});

/** The person's private calendar feed (GET /ics/{uid}.{token}.ics). rotate: old URLs stop working. */
export const icsFeedUrl = defineCommand({
  name: 'icsFeedUrl',
  source: 'extra',
  permission: 'Themselves. rotate: old URLs stop working.',
  errors: [],
  req: req({ rotate: z.literal(true).optional() }),
  res: z.object({ url: z.string(), path: z.string() }),
});

/** The end-to-end smoke command: token verified, runner round-trip, Firestore reachable. */
export const ping = defineCommand({
  name: 'ping',
  source: 'extra',
  permission: 'Any signed-in caller.',
  errors: [],
  req: req({ echo: z.string().max(200).optional() }),
  res: z.object({
    pong: z.literal(true),
    actor: z.string(),
    via: z.string(),
    now: z.number().int(),
    echo: z.string().optional(),
    /** Which Firestore the function talks to. */
    firestore: z.enum(['emulator', 'production']),
  }),
});
