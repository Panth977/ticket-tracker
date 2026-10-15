/**
 * OWNERS AND ORGS (docs/plan/agents.html §AC) — GitHub's shape: everything
 * (a board, an artifact, a bucket) belongs to exactly one OWNER, a person or
 * an org, and lives at /{handle}/b/{KEY}, /{handle}/x/{slug},
 * /{handle}/bucket/{slug}.
 *
 *   handles/{handle}        { kind: 'user' | 'org', id }   one namespace for both
 *   orgs/{orgId}            name, handle, members { uid: owner|admin|member }, baseRole
 *   a thing's `owner`       { kind, id } + `ownerKey` 'user:{uid}' | 'org:{orgId}'
 *
 * ACCESS, AS BEFORE, LIVES ON EACH THING (its access map). An org reaches
 * its things by FAN-OUT: joining an org writes the member onto every thing
 * the org owns, at the role the org gives (orgRoleOn*), and records it in the
 * thing's `orgGranted` map so leaving takes away only what the org gave. A
 * role given to someone directly (a collaborator) is theirs to keep; the
 * higher of the two wins. So every permission check, rule and list query is
 * unchanged — they read the access map, which already says it all.
 */
import { z } from 'zod';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { EmailInputSchema } from '../config.js';
import { DescriptionSchema, IndicatorSchema } from '../types/indicator.js';
import { MillisSchema, UidSchema } from '../types/primitives.js';

// ─── handles ─────────────────────────────────────────────────────────────────

/** 2–39 of a-z 0-9 and '-', not starting or ending with '-' (GitHub's rule). */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/;

/** First path segments the app itself uses — never a handle. */
export const RESERVED_HANDLES = new Set([
  'b',
  'x',
  't',
  'f',
  'w',
  'me',
  'bucket',
  'buckets',
  'inbox',
  'login',
  'logout',
  'account',
  'agents',
  'invite',
  'oauth',
  'welcome',
  'new-board',
  'new',
  'orgs',
  'org',
  'settings',
  'api',
  'v1',
  'mcp',
  'identity',
  'blob',
  'rtdb',
  'c',
  'live',
  'lib',
  'integrate',
  'backend-driver',
  'icons',
  'qa',
  'hooks',
  'ics',
  'integrations',
  'well-known',
  'app',
  'admin',
  'help',
  'about',
  'docs',
  'search',
  'static',
  'assets',
  'config',
  'favicon',
  'manifest',
  'offline',
  'llms',
  'llms-full',
  'sitemap',
  'robots',
  'www',
  'root',
  'system',
]);

export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HANDLE_RE, '2–39 letters, digits or -, not starting or ending with -')
  .refine((h) => !RESERVED_HANDLES.has(h), 'That name is taken by the app');

/** handles/{handle} */
export const HandleDocSchema = z.object({
  kind: z.enum(['user', 'org']),
  id: z.string().min(1),
});
export type HandleDoc = z.infer<typeof HandleDocSchema>;

/** A handle made from a name or an e-mail: 'Panth Patel' → 'panth-patel'. */
export function handleFrom(text: string): string {
  const base = text
    .toLowerCase()
    .split('@')[0]!
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const h = base.length >= 2 ? base : `${base || 'u'}-x`;
  return RESERVED_HANDLES.has(h) ? `${h}-1` : h;
}

// ─── owners ──────────────────────────────────────────────────────────────────

export { OWNER_KINDS, OwnerRefSchema, ownerKeyOf, type OwnerRef } from './owner.js';
import { OwnerRefSchema } from './owner.js';

/** A slug for an artifact / bucket name, unique per owner by the server. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'untitled';
}
export const SlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/);

// ─── orgs ────────────────────────────────────────────────────────────────────

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const OrgRoleSchema = z.enum(ORG_ROLES);

/** What every org member gets on everything the org owns (owners and admins: full). */
export const ORG_BASE_ROLES = ['none', 'viewer', 'commenter', 'editor', 'admin'] as const;
export type OrgBaseRole = (typeof ORG_BASE_ROLES)[number];
export const OrgBaseRoleSchema = z.enum(ORG_BASE_ROLES);

export const ORG_NAME_MAX = 80;
export const ORGS_PER_PERSON_MAX = 50;

/** orgs/{orgId} */
export const OrgSchema = z.object({
  handle: z.string(),
  name: z.string().min(1).max(ORG_NAME_MAX),
  description: DescriptionSchema.optional(),
  indicator: IndicatorSchema.optional(),
  members: z.record(UidSchema, OrgRoleSchema),
  /** Keys of members (array-contains queries). */
  memberUids: z.array(UidSchema),
  baseRole: OrgBaseRoleSchema,
  createdBy: UidSchema,
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
});
export type Org = z.infer<typeof OrgSchema>;

/** The board role an org role (with the org's base role) gives; null = none. */
export function orgRoleOnBoard(
  role: OrgRole,
  base: OrgBaseRole,
): 'admin' | 'editor' | 'commenter' | 'viewer' | null {
  if (role === 'owner' || role === 'admin') return 'admin';
  return base === 'none' ? null : base;
}
/** The artifact / bucket role an org role gives; null = none. */
export function orgRoleOnItem(
  role: OrgRole,
  base: OrgBaseRole,
): 'owner' | 'editor' | 'viewer' | null {
  if (role === 'owner' || role === 'admin') return 'owner';
  if (base === 'none') return null;
  return base === 'editor' || base === 'admin' ? 'editor' : 'viewer';
}

const OrgIdSchema = z.string().min(1).max(64);

export const orgCreate = defineCommand({
  name: 'orgCreate',
  source: 'extra',
  scopes: ['boards:create'],
  permission: 'Any signed-in person (never an agent). They become its owner. 50 orgs per person.',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    handle: HandleSchema,
    name: z.string().trim().min(1).max(ORG_NAME_MAX),
    description: DescriptionSchema.optional(),
    indicator: IndicatorSchema.optional(),
    baseRole: OrgBaseRoleSchema.optional(),
  }),
  res: z.object({ orgId: OrgIdSchema, handle: z.string() }),
});

export const orgUpdate = defineCommand({
  name: 'orgUpdate',
  source: 'extra',
  scopes: ['boards:admin'],
  permission:
    "The org's owners and admins. Changing the base role re-applies it to everything the org owns.",
  errors: ['forbidden', 'not_found', 'invalid', 'conflict'],
  req: req({
    orgId: OrgIdSchema,
    handle: HandleSchema.optional(),
    name: z.string().trim().min(1).max(ORG_NAME_MAX).optional(),
    description: DescriptionSchema.optional(),
    indicator: IndicatorSchema.optional(),
    baseRole: OrgBaseRoleSchema.optional(),
  }),
  res: OkResSchema,
});

export const orgDelete = defineCommand({
  name: 'orgDelete',
  source: 'extra',
  scopes: ['boards:admin'],
  permission:
    "The org's owners, once it owns nothing (move or delete its boards, artifacts and buckets first).",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({ orgId: OrgIdSchema }),
  res: OkResSchema,
});

export const orgInvite = defineCommand({
  name: 'orgInvite',
  source: 'extra',
  scopes: ['invites:write'],
  permission:
    "The org's owners and admins (only owners invite owners). An invite per address; it is accepted like a board invite.",
  errors: ['forbidden', 'not_found', 'rate_limited'],
  req: req({
    orgId: OrgIdSchema,
    invites: z
      .array(z.object({ email: EmailInputSchema, role: OrgRoleSchema }))
      .min(1)
      .max(50),
    message: z.string().max(1000).optional(),
  }),
  res: z.object({ invited: z.array(z.string()), alreadyMembers: z.array(z.string()) }),
});

export const orgMemberSet = defineCommand({
  name: 'orgMemberSet',
  source: 'extra',
  scopes: ['boards:admin'],
  permission:
    "The org's owners and admins change roles and remove members (only owners touch owners); anyone may remove themselves. An org always keeps an owner.",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({ orgId: OrgIdSchema, uid: UidSchema, role: OrgRoleSchema.nullable() }),
  res: OkResSchema,
});

export const THING_KINDS = ['board', 'artifact', 'bucket'] as const;
export type ThingKind = (typeof THING_KINDS)[number];
export const ThingRefSchema = z.object({
  kind: z.enum(THING_KINDS),
  id: z.string().min(1).max(64),
});

export const ownerTransfer = defineCommand({
  name: 'ownerTransfer',
  source: 'extra',
  scopes: ['boards:admin', 'artifacts:write', 'bucket:write'],
  permission:
    "Whoever fully manages the thing (a board's admin, an artifact's or bucket's owner). It may go to any person (who becomes its admin / owner), or to an org where the mover is an owner or admin. Its people stay; the new org's members are added at the org's roles, the old org's go.",
  errors: ['forbidden', 'not_found', 'conflict', 'invalid'],
  req: req({ thing: ThingRefSchema, to: OwnerRefSchema }),
  res: z.object({ ok: z.literal(true), owner: OwnerRefSchema, handle: z.string() }),
});

export const handleSet = defineCommand({
  name: 'handleSet',
  source: 'extra',
  scopes: ['boards:admin'],
  permission: 'A person, for themselves (never an agent). Old links redirect only within the app.',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({ handle: HandleSchema }),
  res: OkResSchema,
});

/** /{handle}/{kind}/{slug or KEY} → the thing's id (and its canonical handle), if the caller may open it. */
export const pathResolve = defineCommand({
  name: 'pathResolve',
  source: 'extra',
  scopes: ['board:read', 'artifacts:read', 'bucket:read'],
  permission: 'Anyone who may open the thing; for a handle alone, anyone signed in.',
  errors: ['not_found'],
  req: req({
    handle: z.string().min(1).max(64),
    kind: z.enum(THING_KINDS).optional(),
    /** A board KEY, or an artifact / bucket slug. */
    slug: z.string().min(1).max(64).optional(),
  }),
  res: z.object({
    owner: OwnerRefSchema,
    handle: z.string(),
    name: z.string(),
    thing: z.object({ kind: z.enum(THING_KINDS), id: z.string(), slug: z.string() }).nullable(),
  }),
});
