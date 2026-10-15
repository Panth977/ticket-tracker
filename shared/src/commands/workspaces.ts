/**
 * THE SIDEBAR (agents.html §AB2): what a person hides from its root lists.
 * Only ever the caller's own document (users/{actor}/ui/sidebar); a person
 * only, never an agent; only things the caller already reaches. (Workspaces,
 * the person's own bundles, became ORGS — shared/src/org, §AC.)
 */
import { z } from 'zod';
import { BoardIdSchema } from '../types/index.js';
import { defineCommand, OkResSchema, req } from './define.js';

const ArtifactRefIdSchema = z.string().min(1).max(64);

/** Account-level: what a token that may organise your boards carries (MCP / the Claude app). */
const SCOPES = ['boards:create', 'boards:admin'] as const;

/** Hide from / show again in the sidebar's root BOARDS / ARTIFACTS lists. UI only. */
export const sidebarHide = defineCommand({
  name: 'sidebarHide',
  source: 'app',
  scopes: [...SCOPES],
  permission:
    "Any signed-in person, their own sidebar (never an agent). Nothing about the board or artifact changes: it is not archived, and 'All boards' / 'All artifacts' still list it.",
  errors: ['forbidden', 'invalid'],
  req: req({
    boardId: BoardIdSchema.optional(),
    artifactId: ArtifactRefIdSchema.optional(),
    /** bucket.html §F */
    bucketId: ArtifactRefIdSchema.optional(),
    hidden: z.boolean(),
  }).refine(
    (r) => [r.boardId, r.artifactId, r.bucketId].filter((x) => x !== undefined).length === 1,
    'Give exactly one of boardId, artifactId or bucketId',
  ),
  res: OkResSchema,
});
