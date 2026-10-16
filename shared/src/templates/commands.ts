/** Template commands (docs/plan/templates.html §A). */
import { z } from 'zod';
import { BoardIdSchema } from '../types/index.js';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { TemplateIdSchema, TemplateInputSchema } from './schema.js';

export const templateSave = defineCommand({
  name: 'templateSave',
  source: 'extra',
  scopes: ['board:admin', 'boards:admin'],
  permission:
    'can(admin). A template keeps its kind (409 to change it). At most TEMPLATES_MAX per board.',
  errors: ['forbidden', 'not_found', 'conflict', 'invalid'],
  req: req({
    boardId: BoardIdSchema,
    /** Absent = a new template. */
    templateId: TemplateIdSchema.optional(),
    template: TemplateInputSchema,
  }),
  res: z.object({ templateId: TemplateIdSchema }),
});

export const templateDelete = defineCommand({
  name: 'templateDelete',
  source: 'extra',
  scopes: ['board:admin', 'boards:admin'],
  permission: 'can(admin). Views whose cards used it go back to the built-in card.',
  errors: ['forbidden', 'not_found'],
  req: req({ boardId: BoardIdSchema, templateId: TemplateIdSchema }),
  res: OkResSchema,
});
