/**
 * PHASE 16 (docs/plan/agents.html §X) — THE ALLOW LIST, as commands.
 *
 * Three, all for the admin alone (one address, from configuration — never a
 * role, never editable from inside the app):
 *
 *   userList      who is allowed, when they were added, when they last signed in
 *   userAllow     add an ADDRESS — before that person has ever signed in
 *   userDisallow  take access away; it bites on their next request
 *
 * They are app-only (no `scopes`): no token, of any kind, can change who may
 * use this app — the same reasoning as the token deny list in define.ts.
 *
 * `source: 'phase2'` reads "named by docs/plan/agents.html, not by the
 * backend.json files under docs/data" — §X lives in that same file.
 */
import { z } from 'zod';
import { EmailInputSchema } from '../config.js';
import { MillisSchema } from '../types/index.js';
import { defineCommand, req } from './define.js';

/** One row of the Users module. Auth facts (uid, name, sign-in) are read live. */
export const AllowedUserSchema = z.object({
  email: z.string(),
  /** When the admin added them; 0 for the admin's own row (allowed by definition). */
  addedAt: MillisSchema,
  /** The admin's uid, or 'config' for the admin's own row. */
  addedBy: z.string(),
  /** A reminder of who this is, typed by the admin when they added them. */
  note: z.string().optional(),
  /** The admin cannot be removed, and the admin cannot remove themselves. */
  admin: z.boolean(),
  /** Have they ever signed in? null until they do. */
  uid: z.string().nullable(),
  name: z.string().nullable(),
  /** From Auth's own metadata — no document to keep in step. */
  lastSignInAt: MillisSchema.nullable(),
  createdAt: MillisSchema.nullable(),
  /** The mirrored users/{uid}.allowed flag, for the admin to see it is in step. */
  mirrored: z.boolean().nullable(),
});
export type AllowedUser = z.infer<typeof AllowedUserSchema>;

const ListRes = z.object({
  /** The admin first, then everyone else in the order they were added. */
  users: z.array(AllowedUserSchema),
  /** The configured admin address, so the screen can say who to ask. */
  admin: z.string(),
});

export const userList = defineCommand({
  name: 'userList',
  source: 'phase2',
  permission: 'The admin only (the configured address). Nobody else, with any token.',
  errors: ['forbidden'],
  req: req({}),
  res: ListRes,
});

export const userAllow = defineCommand({
  name: 'userAllow',
  source: 'phase2',
  permission: 'The admin only. Adds an ADDRESS; the account may not exist yet.',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    email: EmailInputSchema,
    /** A reminder of who this is, shown in the list. */
    note: z.string().trim().max(200).optional(),
  }),
  res: ListRes,
});

export const userDisallow = defineCommand({
  name: 'userDisallow',
  source: 'phase2',
  permission: 'The admin only. The admin address itself can never be removed (409).',
  errors: ['forbidden', 'invalid', 'conflict', 'not_found'],
  req: req({ email: EmailInputSchema }),
  res: ListRes,
});
