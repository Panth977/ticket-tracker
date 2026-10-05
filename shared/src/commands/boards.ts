/**
 * Board, invite, view and tag commands (app/backend.json services).
 */
import { z } from 'zod';
import { BoardPrefSchema, BoardSettingsSchema, ViewSchema } from '../schema/board.js';
import {
  BoardIdSchema,
  BoardKeySchema,
  BoardRoleSchema,
  ColorSchema,
  EmailSchema,
  FieldDefSchema,
  OptionSchema,
  RichTextDocSchema,
  StageGrantSchema,
  StageSchema,
  UidSchema,
} from '../types/index.js';
import { defineCommand, OkResSchema, req } from './define.js';
import { AGG_FIELDS_MAX, AggFieldDefSchema } from '../schema/aggregates.js';
import { DescriptionSchema, IndicatorSchema } from '../types/indicator.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';

export const MAX_INVITES_PER_CALL = 50;

export const inviteCreate = defineCommand({
  name: 'inviteCreate',
  source: 'app',
  // §R1: an account token reaches this with invites:write; a board token
  // still needs board:admin, exactly as before.
  scopes: ['board:admin', 'invites:write'],
  permission: 'can(admin) — or editor when board.settings.editorsCanInvite. 50 invites/person/day.',
  errors: ['forbidden', 'not_found', 'rate_limited'],
  req: req({
    boardId: BoardIdSchema,
    invites: z
      .array(
        z.object({ email: EmailSchema.transform((e) => e.toLowerCase()), role: BoardRoleSchema }),
      )
      .min(1)
      .max(MAX_INVITES_PER_CALL),
    message: z.string().max(1000).optional(),
  }),
  res: z.object({
    /** Lower-cased emails an invite was created or refreshed for. */
    invited: z.array(z.string()),
    alreadyOnBoard: z.array(z.string()),
  }),
});

export const inviteAccept = defineCommand({
  name: 'inviteAccept',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['invites:write'],
  source: 'app',
  permission: 'The signed-in account whose VERIFIED email equals invite.email.',
  errors: ['gone', 'not_found', 'forbidden'],
  req: req({
    inviteId: z.string().min(1),
    /** From the email link; absent when accepting from the inbox. */
    token: z.string().min(1).optional(),
    /** false = decline */
    accept: z.boolean(),
  }),
  res: z.object({
    boardId: BoardIdSchema,
    boardKey: BoardKeySchema,
    /**
     * Set when the invite was to an ARTIFACT (artifacts.html §B): go to
     * /x/{artifactId}. boardId / boardKey are then the fixed
     * ARTIFACT_INVITE_BOARD_ID / _KEY and name no board.
     */
    artifactId: ArtifactIdSchema.optional(),
  }),
});

export const inviteRevoke = defineCommand({
  name: 'inviteRevoke',
  source: 'app',
  /** §R1: account tokens only — the admin path additionally needs boards:admin (can(admin)). */
  scopes: ['invites:write', 'boards:admin'],
  permission: "can(admin) on the invite's board, or its inviter.",
  errors: ['forbidden', 'not_found', 'gone'],
  req: req({
    inviteId: z.string().min(1),
    /** true = new token, new expiry, the email again (instead of revoking). */
    resend: z.literal(true).optional(),
  }),
  res: OkResSchema,
});

export const BOARD_TEMPLATES = ['blank', 'kanban', 'bugs', 'support', 'sprint'] as const;
export const BoardTemplateSchema = z.union([
  z.enum(BOARD_TEMPLATES),
  z.object({ fromBoardId: BoardIdSchema }),
]);
export type BoardTemplate = z.infer<typeof BoardTemplateSchema>;

export const boardCreate = defineCommand({
  name: 'boardCreate',
  source: 'app',
  /** §R1: account tokens only. A board token names one board and cannot make another. */
  scopes: ['boards:create'],
  permission:
    'Any signed-in user (10 new boards/person/day). { fromBoardId } needs can(read) on it.',
  errors: ['conflict', 'forbidden', 'not_found', 'rate_limited'],
  req: req({
    name: z.string().trim().min(1).max(80),
    /** 409 if boardKeys/{key} exists. */
    key: BoardKeySchema,
    template: BoardTemplateSchema.optional(),
    color: ColorSchema.optional(),
    icon: z.string().max(64).optional(),
    /** indicators.html: the board's mark. Default: one from `color`/`icon`, else a palette colour from the name. */
    indicator: IndicatorSchema.optional(),
    /** indicators.html: plain text — what this board is for (agents read it). */
    description: DescriptionSchema.optional(),
  }),
  res: z.object({ boardId: BoardIdSchema }),
});

/** Patches are PER SECTION — never a whole settings blob. */
export const BoardPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: ColorSchema,
    icon: z.string().max(64),
    /** indicators.html: plain text now (old clients may still send rich text; stored flattened). */
    description: z.union([DescriptionSchema, RichTextDocSchema]).nullable(),
    /** indicators.html */
    indicator: IndicatorSchema,
    stages: z.array(StageSchema).min(1),
    priorities: z.array(OptionSchema),
    tags: z.array(OptionSchema),
    /** A field missing from the new list is ARCHIVED, never deleted. */
    fields: z.array(FieldDefSchema),
    /** aggregates.html: a field missing from the new list is ARCHIVED (history kept), never deleted. */
    aggFields: z.array(AggFieldDefSchema).max(AGG_FIELDS_MAX),
    settings: BoardSettingsSchema.partial(),
    defaultViewId: z.string().min(1),
  })
  .partial()
  .strict();
export type BoardPatch = z.infer<typeof BoardPatchSchema>;

export const boardUpdate = defineCommand({
  name: 'boardUpdate',
  source: 'app',
  scopes: ['board:admin', 'boards:admin'],
  permission: 'can(admin).',
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    boardId: BoardIdSchema,
    patch: BoardPatchSchema,
    /** Removing a stage/priority in use needs somewhere to put its tickets (old id → new id). 409 { stageId, count } otherwise. */
    remap: z
      .object({
        stages: z.record(z.string(), z.string()).optional(),
        priorities: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  }),
  res: OkResSchema,
});

export const tagCreate = defineCommand({
  name: 'tagCreate',
  source: 'app',
  scopes: ['tickets:update'],
  permission: 'can(edit). Same name in any case returns the existing tag.',
  errors: ['forbidden', 'not_found'],
  req: req({
    boardId: BoardIdSchema,
    name: z.string().trim().min(1).max(60),
    color: ColorSchema.optional(),
  }),
  res: z.object({ tag: OptionSchema }),
});

export const boardAccessSet = defineCommand({
  name: 'boardAccessSet',
  source: 'app',
  /** §R1: account tokens only ('settings and people on boards where you are an admin'). */
  scopes: ['boards:admin'],
  permission:
    "can(admin), except 'leave', which anyone on the board may do. At least one admin must remain (409).",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({
    boardId: BoardIdSchema,
    /** Change a role; null removes them. Never adds new people — that is invites. People only: agent ids → 400 (use boardAgentSet). */
    people: z.record(UidSchema, BoardRoleSchema.nullable()).optional(),
    stageGrants: z.record(UidSchema, StageGrantSchema.nullable()).optional(),
    /** Remove yourself. */
    leave: z.literal(true).optional(),
  }),
  res: OkResSchema,
});

export const boardArchive = defineCommand({
  name: 'boardArchive',
  source: 'app',
  /** §R1: account tokens only. 'delete' still needs confirmKey and can(admin). */
  scopes: ['boards:admin'],
  permission: "can(admin). 'delete' requires confirmKey === board.key.",
  errors: ['forbidden', 'not_found', 'invalid'],
  req: req({
    boardId: BoardIdSchema,
    action: z.enum(['archive', 'restore', 'delete']),
    confirmKey: BoardKeySchema.optional(),
  }),
  res: OkResSchema,
});

export const boardPrefSet = defineCommand({
  name: 'boardPrefSet',
  // MCP (the Claude app as the whole UI): a write, so a write scope — never a read-only token.
  scopes: ['tickets:update', 'board:admin', 'boards:admin'],
  source: 'app',
  permission: "can(read). Always the caller's own prefs/{actor} — there is no uid parameter.",
  errors: ['forbidden', 'not_found'],
  req: req({ boardId: BoardIdSchema, pref: BoardPrefSchema.partial().strict() }),
  res: OkResSchema,
});

/** A view as the client sends it — ownerUid is always the actor. */
export const ViewInputSchema = ViewSchema.omit({ ownerUid: true });
export type ViewInput = z.infer<typeof ViewInputSchema>;

export const viewSave = defineCommand({
  name: 'viewSave',
  // MCP (the Claude app as the whole UI): a write, so a write scope — never a read-only token.
  scopes: ['tickets:update', 'board:admin', 'boards:admin'],
  source: 'app',
  permission: 'personal → can(read) (and its owner, when updating); shared → can(edit).',
  errors: ['forbidden', 'not_found'],
  req: req({ boardId: BoardIdSchema, viewId: z.string().min(1).optional(), view: ViewInputSchema }),
  res: z.object({ viewId: z.string() }),
});

export const viewDelete = defineCommand({
  name: 'viewDelete',
  // MCP (the Claude app as the whole UI): a write, so a write scope — never a read-only token.
  scopes: ['tickets:update', 'board:admin', 'boards:admin'],
  source: 'app',
  permission:
    "personal → its owner; shared → can(edit). The board's default view cannot be deleted (409).",
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({ boardId: BoardIdSchema, viewId: z.string().min(1) }),
  res: OkResSchema,
});
