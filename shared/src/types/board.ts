/**
 * Board-shape types (docs/data/app/db.json `types`): roles, stages, options,
 * custom fields, filters, views, ticket state, attachments.
 */
import { z } from 'zod';
import {
  BoardIdSchema,
  ColorSchema,
  LocalIdSchema,
  MillisSchema,
  StoragePathSchema,
  TicketIdSchema,
  PrincipalIdSchema,
  UidSchema,
} from './primitives.js';

/**
 * THE ONLY ROLE THERE IS — there is no app-level role, workspace or team.
 *   admin      settings, invite and remove people, change roles, delete
 *   editor     create + edit every field, move anywhere
 *   commenter  read + post in threads + move within their StageGrant
 *   viewer     read only
 */
export const BOARD_ROLES = ['admin', 'editor', 'commenter', 'viewer'] as const;
export const BoardRoleSchema = z.enum(BOARD_ROLES);
export type BoardRole = z.infer<typeof BoardRoleSchema>;

/** What the SYSTEM reads; stage names are the board's own words. */
export const STAGE_CATEGORIES = ['backlog', 'todo', 'active', 'done', 'cancelled'] as const;
export const StageCategorySchema = z.enum(STAGE_CATEGORIES);
export type StageCategory = z.infer<typeof StageCategorySchema>;

export const StageSchema = z.object({
  /** 7-char base36, board-local. */
  id: LocalIdSchema,
  name: z.string().min(1).max(60),
  color: ColorSchema,
  category: StageCategorySchema,
  position: z.number(),
  /** Kanban column warns above this. */
  wipLimit: z.number().int().positive().optional(),
  /** Field ids that must be set to ENTER this stage (enforced server-side → 422). */
  requires: z.array(z.string()).optional(),
});
export type Stage = z.infer<typeof StageSchema>;

/** Per person: a commenter may move tickets between THESE stages only. */
export const StageGrantSchema = z.object({
  stages: z.array(LocalIdSchema),
  /** Only tickets assigned to them. */
  assignedOnly: z.boolean().optional(),
});
export type StageGrant = z.infer<typeof StageGrantSchema>;

/** A priority, a tag, a select choice. */
export const OptionSchema = z.object({
  id: LocalIdSchema,
  name: z.string().min(1).max(60),
  color: ColorSchema.optional(),
  position: z.number(),
});
export type Option = z.infer<typeof OptionSchema>;

export const FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'currency',
  'percent',
  'select',
  'multiSelect',
  'checkbox',
  'rating',
  'date',
  'dateRange',
  'person',
  'people',
  'url',
  'email',
  'phone',
  'ticketRelation',
  /** Phase 3 — computed on the server, read-only. */
  'formula',
] as const;
export const FieldTypeSchema = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldTypeSchema>;

/** Custom field ids: 'f_' + 6 chars; the key in Ticket.fields. */
export const FIELD_ID_RE = /^f_[a-z0-9]{6}$/;
export const FieldIdSchema = z.string().regex(FIELD_ID_RE, "Field id: 'f_' + 6 chars");

export const FieldDefSchema = z.object({
  id: FieldIdSchema,
  name: z.string().min(1).max(60),
  type: FieldTypeSchema,
  /** select, multiSelect */
  options: z.array(OptionSchema).optional(),
  config: z
    .object({
      currency: z.string().optional(),
      precision: z.number().int().min(0).max(10).optional(),
      /** rating */
      max: z.number().int().positive().optional(),
      relationBoardId: BoardIdSchema.optional(),
      formula: z.string().optional(),
    })
    .optional(),
  /** Enforced by ticketCreate / ticketUpdate. */
  required: z.boolean().optional(),
  showOnCard: z.boolean().optional(),
  position: z.number(),
  /** Hidden, values kept — never destructive. */
  archived: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

export const DateRangeSchema = z.object({ start: MillisSchema, end: MillisSchema });
export type DateRange = z.infer<typeof DateRangeSchema>;

/**
 * Stored under the field's ID, never its name. string[] covers multiSelect
 * option ids, people uids and ticketRelation ticket ids alike.
 */
export const FieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
  DateRangeSchema,
]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const CMPS = [
  'is',
  'isNot',
  'in',
  'notIn',
  'contains',
  'empty',
  'notEmpty',
  'lt',
  'gt',
  'between',
  'before',
  'after',
] as const;
export const CmpSchema = z.enum(CMPS);
export type Cmp = z.infer<typeof CmpSchema>;

/** Built-in filterable fields; custom fields are `fields.${fieldId}`. */
export const FILTER_FIELDS = [
  'stage',
  'priority',
  'assignee',
  'tag',
  'due',
  'state',
  'createdBy',
  'text',
  'linked',
] as const;
/** Value tokens resolved at evaluation time, so a saved view means the same to everyone. */
export const FILTER_TOKENS = ['me', 'today', 'thisWeek', 'overdue'] as const;
export type FilterToken = (typeof FILTER_TOKENS)[number];

export const FilterFieldSchema = z
  .string()
  .refine(
    (f) => (FILTER_FIELDS as readonly string[]).includes(f) || /^fields\.f_[a-z0-9]{6}$/.test(f),
    {
      message: 'Unknown filter field',
    },
  );

export type FilterGroup = { op: 'and' | 'or'; children: FilterNode[] };
export type FilterLeaf = { field: string; cmp: Cmp; value?: unknown };
export type FilterNode = FilterGroup | FilterLeaf;

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['and', 'or']), children: z.array(FilterNodeSchema).max(50) }),
    z.object({ field: FilterFieldSchema, cmp: CmpSchema, value: z.unknown().optional() }),
  ]),
);

export const isFilterGroup = (n: FilterNode): n is FilterGroup => 'op' in n;

/** Four, each with a component that draws it. */
export const VIEW_TYPES = ['kanban', 'table', 'calendar', 'timeline'] as const;
export const ViewTypeSchema = z.enum(VIEW_TYPES);
export type ViewType = z.infer<typeof ViewTypeSchema>;

/**
 * A lifecycle ORTHOGONAL to the stage. Archived tickets are read-only and
 * leave every default view; restoring is admin-only.
 *
 * Phase 6: 'cancelled' is gone. Archive already covered 'keep it but out of
 * the way', so a third read-only state earned nothing — the menu now offers
 * Archive (reversible) or Delete (permanent). Note StageCategory still has a
 * 'cancelled' category: that is a COLUMN ("Won't do"), not the ticket's state.
 */
export const TICKET_STATES = ['active', 'archived'] as const;
export const TicketStateSchema = z.enum(TICKET_STATES);
export type TicketState = z.infer<typeof TicketStateSchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  /** Storage path — NEVER a download URL. */
  path: StoragePathSchema,
  name: z.string().min(1).max(255),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  /** Images, for layout before load. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Written by onAttachmentFinalized. */
  thumbPath: StoragePathSchema.optional(),
  /** A principal: a person or an agent (via its token). */
  uploadedBy: PrincipalIdSchema,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const TICKET_LINK_TYPES = ['blocks', 'blockedBy', 'relates', 'duplicates'] as const;
export const TicketLinkTypeSchema = z.enum(TICKET_LINK_TYPES);
export type TicketLinkType = z.infer<typeof TicketLinkTypeSchema>;
export const TicketLinkSchema = z.object({ type: TicketLinkTypeSchema, ticketId: TicketIdSchema });
export type TicketLink = z.infer<typeof TicketLinkSchema>;
/** The link written on the OTHER ticket (blocks ↔ blockedBy; the rest are symmetric). */
export const INVERSE_LINK: Record<TicketLinkType, TicketLinkType> = {
  blocks: 'blockedBy',
  blockedBy: 'blocks',
  relates: 'relates',
  duplicates: 'duplicates',
};
