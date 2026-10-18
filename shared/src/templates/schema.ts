/**
 * TEMPLATES (docs/plan/templates.html) — a board's own code for three places:
 *
 *   message  the composer's 📋 button: a form whose submit posts a message
 *   ticket   New ticket › a template: a form whose submit creates a ticket
 *   card     a kanban view's card: what each card shows
 *
 * A template is JavaScript the board's admins write (or ask an agent to
 * write). It never runs in the app's page: the browser runs it in a Worker
 * with an OPAQUE origin (a data: URL — no cookies, no IndexedDB, no app
 * storage) and the app only draws the tree its `render` returns (§B). This
 * file is the stored shape and the wire shapes its results are checked with.
 */
import { z } from 'zod';
import { MillisSchema, PrincipalIdSchema } from '../types/index.js';
import { DescriptionSchema, IndicatorSchema } from '../types/indicator.js';

export const TEMPLATE_KINDS = ['message', 'ticket', 'card'] as const;
export const TemplateKindSchema = z.enum(TEMPLATE_KINDS);
export type TemplateKind = z.infer<typeof TemplateKindSchema>;

/** Templates per board, all kinds together. */
export const TEMPLATES_MAX = 50;
/** Characters of code in one template. */
export const TEMPLATE_CODE_MAX = 100_000;
/** Bytes of JSON a message template may attach as `data` (Message.template.data). */
export const TEMPLATE_DATA_MAX = 16_000;

export const TemplateIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Template ids are letters, digits, _ and -');

/** boards/{boardId}/templates/{templateId} — readable by the board, written by templateSave. */
export const TemplateSchema = z.object({
  kind: TemplateKindSchema,
  name: z.string().min(1).max(60),
  /** indicators.html: plain text — what it is for (agents read it). */
  description: DescriptionSchema,
  /** indicators.html: its mark in the composer's menu, the New ticket picker and settings. */
  indicator: IndicatorSchema.optional(),
  /** The source: JavaScript with one `export default { … }` (§C). */
  code: z.string().max(TEMPLATE_CODE_MAX),
  /** Order in pickers (ascending). */
  position: z.number(),
  createdBy: PrincipalIdSchema,
  createdAt: MillisSchema,
  updatedBy: PrincipalIdSchema,
  updatedAt: MillisSchema,
});
export type Template = z.infer<typeof TemplateSchema>;
export type TemplateWithId = Template & { id: string };

/** What templateSave takes: the authored part. */
export const TemplateInputSchema = TemplateSchema.pick({
  kind: true,
  name: true,
  code: true,
})
  .extend({
    name: z.string().trim().min(1).max(60),
    description: DescriptionSchema.optional(),
    indicator: IndicatorSchema.optional(),
    position: z.number().optional(),
  })
  .strict();
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

/** JSON a message template attaches; size-checked (TEMPLATE_DATA_MAX) where it is accepted. */
export const TemplateDataSchema = z.unknown().refine(
  (v) => {
    try {
      return JSON.stringify(v ?? null).length <= TEMPLATE_DATA_MAX;
    } catch {
      return false;
    }
  },
  { message: `Template data is JSON of at most ${TEMPLATE_DATA_MAX} characters` },
);

/** Message.template — which template wrote the message, and what its form held. */
export const MessageTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: z.string().min(1).max(60),
  data: TemplateDataSchema.optional(),
});
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

/**
 * §D — what a `submit` answers, checked in the app before anything is sent.
 * `invalid` keeps the form open: `errMsg` is shown above the buttons and
 * `error`, when it is an object, puts each value under the input whose
 * `name` is its key.
 */
export const TemplateInvalidSchema = z.object({
  type: z.literal('invalid'),
  errMsg: z.string().max(2000).optional(),
  error: z.unknown().optional(),
});

export const MessageTemplateResultSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('valid'),
    /** The message, as Markdown (mentions as @email, tickets as #KEY). */
    msg: z.string().min(1).max(100_000),
    /** Kept on the message as template.data — what an agent reads instead of parsing `msg`. */
    data: TemplateDataSchema.optional(),
  }),
  TemplateInvalidSchema,
]);
export type MessageTemplateResult = z.infer<typeof MessageTemplateResultSchema>;

/** Board things are named by id OR by name (a stage 'In progress', a tag 'bug', a person by email). */
const Ref = z.string().min(1).max(200);
const When = z.union([z.number(), z.string().min(1).max(40)]);

export const TicketTemplateTicketSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    /** Markdown. */
    description: z.string().max(100_000).optional(),
    stage: Ref.optional(),
    priority: Ref.nullable().optional(),
    /** Tag ids or names; a name the board does not have yet becomes a new tag. */
    tags: z.array(Ref).max(50).optional(),
    /** Member ids, emails or names (people and agents). */
    assignees: z.array(Ref).max(50).optional(),
    /** Millis, or an ISO date ('2026-10-20') / date-time. */
    dueAt: When.nullable().optional(),
    dueAllDay: z.boolean().optional(),
    startAt: When.nullable().optional(),
    estimate: z.number().nonnegative().nullable().optional(),
    /** Custom field id OR name → value (select options by id or name). */
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type TicketTemplateTicket = z.infer<typeof TicketTemplateTicketSchema>;

export const TicketTemplateResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('valid'), ticket: TicketTemplateTicketSchema }),
  TemplateInvalidSchema,
]);
export type TicketTemplateResult = z.infer<typeof TicketTemplateResultSchema>;

/** The template every new one starts from, per kind (the editor's "New"). */
export const TEMPLATE_STARTERS: Record<TemplateKind, string> = {
  message: `// A message template: a small form whose submit posts a message.
// Docs: /integrate#9-templates
export default {
  state: (ctx) => ({ kind: 'bug', steps: '', severity: 'medium' }),

  render(state, setState, h, ctx) {
    return h.col(
      h.select({
        label: 'Type',
        value: state.kind,
        options: [
          { value: 'bug', label: 'Bug' },
          { value: 'question', label: 'Question' },
        ],
        onChange: (kind) => setState({ kind }),
      }),
      state.kind === 'bug' &&
        h.select({
          label: 'Severity',
          value: state.severity,
          options: ['low', 'medium', 'high'],
          onChange: (severity) => setState({ severity }),
        }),
      h.textarea({
        label: state.kind === 'bug' ? 'Steps to reproduce' : 'Your question',
        name: 'steps',
        value: state.steps,
        rows: 4,
        onInput: (steps) => setState({ steps }),
      }),
    );
  },

  submit(state, ctx) {
    if (!state.steps.trim())
      return { type: 'invalid', errMsg: 'Fill in the text', error: { steps: 'Required' } };
    const head = state.kind === 'bug' ? \`**Bug** · severity \${state.severity}\` : '**Question**';
    return { type: 'valid', msg: \`\${head}\\n\\n\${state.steps}\`, data: state };
  },
};
`,
  ticket: `// A ticket template: a form whose submit creates a ticket.
// Docs: /integrate#9-templates
export default {
  state: (ctx) => ({ title: '', area: '', details: '' }),

  render(state, setState, h, ctx) {
    return h.col(
      h.input({ label: 'Title', name: 'title', value: state.title, onInput: (title) => setState({ title }) }),
      h.select({
        label: 'Area',
        value: state.area,
        options: ['', 'Frontend', 'Backend', 'Infra'],
        onChange: (area) => setState({ area }),
      }),
      h.textarea({ label: 'Details', value: state.details, rows: 5, onInput: (details) => setState({ details }) }),
    );
  },

  submit(state, ctx) {
    if (!state.title.trim()) return { type: 'invalid', error: { title: 'A ticket needs a title' } };
    return {
      type: 'valid',
      ticket: {
        title: state.area ? \`[\${state.area}] \${state.title}\` : state.title,
        description: state.details,
      },
    };
  },
};
`,
  card: `// A card template: what each card on a kanban view shows.
// ctx.ticket is the card's ticket. Docs: /integrate#9-templates
export default {
  render(state, setState, h, ctx) {
    const t = ctx.ticket;
    return h.col(
      h.row(h.text(t.key, { tone: 'subtle', mono: true, size: 'xs' }), t.priority && h.badge(t.priority.name, { color: t.priority.color })),
      h.text(t.title, { weight: 'medium' }),
      t.assignees.length > 0 && h.row(...t.assignees.map((a) => h.person(a.id))),
    );
  },
};
`,
};
