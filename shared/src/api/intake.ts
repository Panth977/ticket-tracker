/**
 * Intake: the website feedback widget (platform/backend.json intakeSubmit),
 * authorised by a board's slug + secret headers instead of a session.
 */
import { z } from 'zod';
import { PublicFieldSchema, PublicOptionSchema, PublicStageRefSchema } from './public.js';

export const INTAKE_HEADERS = { slug: 'x-tm-intake', secret: 'x-tm-secret' } as const;
/** ≤ 5 MB of attachments in total, measured on the decoded bytes. */
export const INTAKE_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** POST /v1/intake */
export const IntakeSubmitReqSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(50_000).optional(),
    reporter: z
      .object({ email: z.string().email(), name: z.string().max(120).optional() })
      .optional(),
    /** Page URL, user agent, app version… — mapped to fields through intake.fieldMap. */
    meta: z.record(z.string(), z.unknown()).optional(),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(255), contentBase64: z.string().min(1) }))
      .max(10)
      .optional(),
  })
  .strict();
export type IntakeSubmitReq = z.infer<typeof IntakeSubmitReqSchema>;

export const IntakeSubmitResSchema = z.object({ id: z.string(), key: z.string() });
export type IntakeSubmitRes = z.infer<typeof IntakeSubmitResSchema>;

/** GET /v1/intake/schema → the board's public options for the widget's selects. */
export const IntakeSchemaResSchema = z.object({
  board: z.object({ key: z.string(), name: z.string() }),
  stages: z.array(PublicStageRefSchema),
  priorities: z.array(PublicOptionSchema),
  tags: z.array(PublicOptionSchema),
  fields: z.array(PublicFieldSchema),
});
export type IntakeSchemaRes = z.infer<typeof IntakeSchemaResSchema>;
