/**
 * DICTIONARY (docs/plan/dictionary.html §C) — the commands. Every door (the
 * app's /api, /v1 REST, MCP) calls these.
 *
 * Tokens: `dictionary:read` / `dictionary:write`. An account token or an
 * OAuth grant reaches what its person reaches; an agent token reaches the
 * dictionaries granted to the agent and to a board it is on.
 */
import { z } from 'zod';
import { OwnerRefSchema } from '../org/owner.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { EmailInputSchema } from '../config.js';
import { AgentIdSchema, BoardIdSchema, MillisSchema } from '../types/index.js';
import { IndicatorSchema } from '../types/indicator.js';
import {
  DICTIONARY_DESCRIPTION_MAX,
  DICTIONARY_ENTRIES_MAX,
  DICTIONARY_NAME_MAX,
  DictionaryEntrySchema,
  DictionaryGrantSchema,
  DictionaryIdSchema,
  DictionaryKeySchema,
  DictionaryShareRoleSchema,
  DictionaryValueSchema,
} from './schema.js';

const Name = z.string().trim().min(1).max(DICTIONARY_NAME_MAX);
const Description = z.string().trim().max(DICTIONARY_DESCRIPTION_MAX);

/** A dictionary as the API returns it, with what the CALLER may do there. */
export const DictionaryOutSchema = z.object({
  id: DictionaryIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  indicator: IndicatorSchema,
  /** Its owner's handle and its slug: /{handle}/dictionary/{slug}. */
  handle: z.string().nullable(),
  slug: z.string().nullable(),
  reach: z.enum(['manage', 'write', 'read']),
  archived: z.boolean(),
  stats: z.object({ entries: z.number(), bytes: z.number() }),
  updatedAt: MillisSchema,
  /** dictionaryList({ boardId | artifactId | agentId }) only: THAT one's grant. */
  grant: DictionaryGrantSchema.optional(),
});
export type DictionaryOut = z.infer<typeof DictionaryOutSchema>;

const EntriesOut = z.object({
  dictionary: DictionaryOutSchema,
  entries: z.array(z.object({ key: z.string(), value: z.unknown() })),
  entriesUpdatedAt: MillisSchema.nullable(),
});

// ─── the dictionary ──────────────────────────────────────────────────────────

export const dictionaryCreate = defineCommand({
  name: 'dictionaryCreate',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission:
    'Any person, or an account token / OAuth grant with dictionary:write; they become its owner (or the org they name, where they are an owner or admin). Never an agent token.',
  errors: ['forbidden', 'invalid', 'conflict'],
  req: req({
    name: Name,
    description: Description.nullable().optional(),
    indicator: IndicatorSchema.optional(),
    /** §AC: who owns it — you (default) or an org you belong to. */
    owner: OwnerRefSchema.optional(),
    /** Entries to start with. */
    entries: z.array(DictionaryEntrySchema).max(DICTIONARY_ENTRIES_MAX).optional(),
  }),
  res: z.object({ dictionaryId: DictionaryIdSchema }),
});

export const dictionaryUpdate = defineCommand({
  name: 'dictionaryUpdate',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission: 'Owner only (404 to anyone who cannot reach it, 403 to editors/viewers).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    dictionaryId: DictionaryIdSchema,
    name: Name.optional(),
    description: Description.nullable().optional(),
    indicator: IndicatorSchema.optional(),
    /** Archive (read-only) or restore. */
    archived: z.boolean().optional(),
  }),
  res: OkResSchema,
});

export const dictionaryDelete = defineCommand({
  name: 'dictionaryDelete',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission:
    'Owner only. The dictionary and its entries go at once; everything granted it stops seeing it.',
  errors: ['not_found', 'forbidden'],
  req: req({ dictionaryId: DictionaryIdSchema }),
  res: OkResSchema,
});

export const dictionaryShare = defineCommand({
  name: 'dictionaryShare',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission:
    "Owner only — never an agent. A person's role by email ('editor' | 'viewer'; null removes). The address must have an account. The owner's own role cannot be changed.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    dictionaryId: DictionaryIdSchema,
    email: EmailInputSchema,
    role: DictionaryShareRoleSchema.nullable(),
  }),
  res: OkResSchema,
});

/**
 * Let a board, an artifact or an agent use this dictionary, or stop it. A
 * ceiling: what a member then does is bounded by their own role.
 */
export const dictionaryGrantSet = defineCommand({
  name: 'dictionaryGrantSet',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission:
    "Granting: the dictionary's OWNER, who must also be an admin of the board, the owner of the artifact, or the owner of the agent. Removing (access null): the dictionary's owner, OR that board's admin / that artifact's owner / that agent's owner — either side may end it. Exactly one of boardId / artifactId / agentId. Never an agent.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    dictionaryId: DictionaryIdSchema,
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    agentId: AgentIdSchema.optional(),
    access: DictionaryGrantSchema.nullable(),
  }).superRefine((r, ctx) => {
    const n = [r.boardId, r.artifactId, r.agentId].filter((x) => x !== undefined).length;
    if (n !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['boardId'],
        message: 'Give exactly one of boardId, artifactId or agentId',
      });
  }),
  res: OkResSchema,
});

// ─── reads ───────────────────────────────────────────────────────────────────

export const dictionaryList = defineCommand({
  name: 'dictionaryList',
  source: 'extra',
  scopes: ['dictionary:read', 'dictionary:write'],
  permission:
    'Anyone: the dictionaries the caller reaches. With boardId: only those granted to that board (the caller must be on it). With artifactId: those granted to that artifact that the caller reaches. With agentId: those granted to that agent (its owner, or the agent itself).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    agentId: AgentIdSchema.optional(),
    includeArchived: z.boolean().optional(),
  }),
  res: z.object({ dictionaries: z.array(DictionaryOutSchema) }),
});

export const dictionaryGet = defineCommand({
  name: 'dictionaryGet',
  source: 'extra',
  scopes: ['dictionary:read', 'dictionary:write'],
  permission: 'Read reach. Every entry, in order; values are JSON.',
  errors: ['not_found'],
  req: req({
    dictionaryId: DictionaryIdSchema,
    /** Only these keys (missing ones are left out). */
    keys: z.array(DictionaryKeySchema).max(DICTIONARY_ENTRIES_MAX).optional(),
  }),
  res: EntriesOut,
});

/**
 * Change entries: `set` some (a null value REMOVES that key; a new key goes at
 * the end), or `replace` them all (the order given is kept). Exactly one.
 * `expectedUpdatedAt` makes it conditional: a 409 when the entries changed
 * since that read.
 */
export const dictionarySet = defineCommand({
  name: 'dictionarySet',
  source: 'extra',
  scopes: ['dictionary:write'],
  permission:
    'Write reach (editor/owner, or editor+ on a board granted write, or an agent granted write).',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    dictionaryId: DictionaryIdSchema,
    set: z.record(DictionaryKeySchema, DictionaryValueSchema.nullable()).optional(),
    replace: z.array(DictionaryEntrySchema).max(DICTIONARY_ENTRIES_MAX).optional(),
    expectedUpdatedAt: MillisSchema.nullable().optional(),
  }).refine((r) => (r.set === undefined) !== (r.replace === undefined), 'Give set or replace'),
  res: EntriesOut,
});
