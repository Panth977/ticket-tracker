/**
 * ARTIFACTS (docs/plan/artifacts.html) — the commands. Every door (the app's
 * /api, /v1 REST, MCP) calls these; reads of the artifact list and document
 * are direct from Firestore in the app, and REST/MCP read them in the door.
 *
 * Tokens (§C4): `artifacts:read` / `artifacts:write`. An account token
 * reaches every artifact where its person is owner or editor; an agent token
 * only the artifacts that agent is on; one it creates belongs to its OWNER,
 * with the agent on it as { build: true, data: 'write' }.
 *
 * agents.html §AA3: what an agent may do on an artifact is { build, data }
 * (schema.ts ArtifactAgentAccessSchema) — publish / roll back / source need
 * `build`; the data API (§AA4, REST + MCP, not commands) needs `data`.
 *
 * The artifact's DATA (Firestore / RTDB / Storage uploads) is not written by
 * commands at all: the host page writes it as the viewer, and the rules
 * decide (§E4). Storage READS, list and delete go through commands because
 * the cross-service rule lookup cannot be relied on (storage.rules header).
 */
import { z } from 'zod';
import { defineCommand, OkResSchema, req } from '../commands/define.js';
import { EmailInputSchema } from '../config.js';
import { AgentIdSchema, BoardIdSchema, MillisSchema } from '../types/index.js';
import {
  ARTIFACT_DESCRIPTION_MAX,
  ARTIFACT_NAME_MAX,
  ArtifactAgentAccessSchema,
  ArtifactBoardAccessSchema,
  ArtifactBuildIdSchema,
  ArtifactIdSchema,
  ArtifactRoleSchema,
  ArtifactShareRoleSchema,
} from './schema.js';

const Name = z.string().trim().min(1).max(ARTIFACT_NAME_MAX);
const Description = z.string().trim().max(ARTIFACT_DESCRIPTION_MAX);
const Message = z.string().trim().max(500);

/** One file of an inline publish (MCP artifact_publish, §C2). */
export const ArtifactInlineFileSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
export type ArtifactInlineFile = z.infer<typeof ArtifactInlineFileSchema>;

export const artifactCreate = defineCommand({
  name: 'artifactCreate',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission:
    "Any allowed person, or an ACCOUNT token with artifacts:write; they become its owner. An AGENT token creates it for the agent's OWNER and is put on it with { build: true, data: 'write' } (§AA3). Never a board token acting as a person.",
  errors: ['forbidden', 'invalid'],
  req: req({
    name: Name,
    description: Description.nullable().optional(),
    icon: z.string().max(16).nullable().optional(),
  }),
  res: z.object({ artifactId: ArtifactIdSchema }),
});

export const artifactUpdate = defineCommand({
  name: 'artifactUpdate',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission: 'Owner only (404 to anyone without a role, 403 to editors/viewers).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    artifactId: ArtifactIdSchema,
    name: Name.optional(),
    description: Description.nullable().optional(),
    icon: z.string().max(16).nullable().optional(),
    /** §B: viewers read-only. */
    readOnly: z.boolean().optional(),
    /** Archive (no data writes, hidden from the sidebar) or restore. */
    archived: z.boolean().optional(),
  }),
  res: OkResSchema,
});

/**
 * §K — let the artifact's page use a board's tickets (BackendDriver.tickets),
 * or stop it. A ceiling only: what a viewer then sees or changes is still
 * bounded by their own role on that board.
 */
export const artifactBoardAccessSet = defineCommand({
  name: 'artifactBoardAccessSet',
  source: 'app',
  scopes: ['artifacts:write'],
  permission:
    'Owner only, and only for a board the owner can read; write needs the owner to be editor or admin there. null removes the board.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    artifactId: ArtifactIdSchema,
    boardId: BoardIdSchema,
    access: ArtifactBoardAccessSchema.nullable(),
  }),
  res: OkResSchema,
});

export const artifactShare = defineCommand({
  name: 'artifactShare',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission:
    "Owner only — never an agent. Exactly one of email (a person: role 'editor' | 'viewer', null removes) or agentId (one of the OWNER's agents). For an agent give agentAccess { build, data } (§AA3; { build: false, data: 'none' } removes it), or the old role form: 'editor' → { build: true, data: 'write' }, null → removed. agentAccess wins when both are given. An email with no account yet → an invite (invites/ with artifactId). The owner's own role cannot be changed.",
  errors: ['not_found', 'forbidden', 'invalid', 'conflict'],
  req: req({
    artifactId: ArtifactIdSchema,
    email: EmailInputSchema.optional(),
    agentId: AgentIdSchema.optional(),
    /**
     * A person's role; null removes. For an agent this is the PRE-§AA3 form
     * and still works ('editor' → both permissions, null → removed). Optional
     * only so an agent can be shared with agentAccess alone.
     */
    role: ArtifactShareRoleSchema.nullable().optional(),
    /** §AA3 — agents only: what this agent may do here. Wins over `role`. */
    agentAccess: ArtifactAgentAccessSchema.optional(),
  }).superRefine((r, ctx) => {
    if (r.email !== undefined && r.agentAccess !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['agentAccess'],
        message: 'agentAccess is for an agent — a person has a role',
      });
    if (r.email !== undefined && r.role === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: "Give a role ('editor', 'viewer' or null)",
      });
    if (r.agentId !== undefined && r.role === undefined && r.agentAccess === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['agentAccess'],
        message: 'Give agentAccess { build, data } (or role) for the agent',
      });
    // The old form knew one agent role. 'viewer' was always coerced to editor
    // before §AA3; now that there is a real way to say "read only", say so.
    if (r.agentId !== undefined && r.agentAccess === undefined && r.role === 'viewer')
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message:
          "An agent has no 'viewer' role — give agentAccess, e.g. { build: false, data: 'read' }",
      });
  }),
  res: z.object({
    ok: z.literal(true),
    /** 'granted' = they had an account and have the role now; 'invited' = an invite waits for their sign-in. */
    outcome: z.enum(['granted', 'invited', 'removed']),
  }),
});

export const artifactPublish = defineCommand({
  name: 'artifactPublish',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission:
    'Owner or editor (people), or an agent with build on it (§AA3). Exactly one of uploadPath (a zip already uploaded to artifacts/{id}/uploads/…) or files (inline, ≤ 5 MB). The new build becomes current.',
  errors: ['not_found', 'forbidden', 'invalid', 'conflict', 'too_large'],
  req: req({
    artifactId: ArtifactIdSchema,
    uploadPath: z.string().max(1024).optional(),
    files: z.array(ArtifactInlineFileSchema).max(2000).optional(),
    /** A source zip already uploaded to artifacts/{id}/uploads/…, kept beside the build. */
    sourceUploadPath: z.string().max(1024).optional(),
    message: Message.nullable().optional(),
  }),
  res: z.object({
    buildId: ArtifactBuildIdSchema,
    files: z.number().int(),
    bytes: z.number().int(),
    warnings: z.array(z.string()),
  }),
});

export const artifactSetCurrent = defineCommand({
  name: 'artifactSetCurrent',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission:
    'Owner or editor, or an agent with build on it (§AA3). Roll back (or forward) to any kept build.',
  errors: ['not_found', 'forbidden'],
  req: req({ artifactId: ArtifactIdSchema, buildId: ArtifactBuildIdSchema }),
  res: OkResSchema,
});

export const artifactDelete = defineCommand({
  name: 'artifactDelete',
  source: 'extra',
  scopes: ['artifacts:write'],
  permission:
    'Owner only. Queues the delete of builds, source, files and ALL data; the document goes last.',
  errors: ['not_found', 'forbidden'],
  req: req({ artifactId: ArtifactIdSchema }),
  res: OkResSchema,
});

/**
 * §D2: what the host page asks for to show an artifact. App-only — a token
 * has no browser to show it in.
 */
export const artifactOpen = defineCommand({
  name: 'artifactOpen',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['artifacts:read', 'artifacts:write'],
  source: 'extra',
  permission:
    'Anyone with a role. The capability is for the CURRENT build unless buildId names a kept one.',
  errors: ['not_found', 'conflict'],
  req: req({ artifactId: ArtifactIdSchema, buildId: ArtifactBuildIdSchema.optional() }),
  res: z.object({
    /** The full URL of the build's index.html on the usercontent site: {origin}/c/{capability}/index.html */
    contentUrl: z.string(),
    /** The URL prefix that every file of this build lives under ({origin}/c/{capability}/). */
    contentBase: z.string(),
    buildId: ArtifactBuildIdSchema,
    role: ArtifactRoleSchema,
    readOnly: z.boolean(),
    expiresAt: MillisSchema,
  }),
});

/** db.storage.url — a short-lived signed URL for one of the artifact's files. */
export const artifactFileUrl = defineCommand({
  name: 'artifactFileUrl',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['artifacts:read', 'artifacts:write'],
  source: 'extra',
  permission: "Anyone with a role. path is in the artifact's own view (artifactStorageFile).",
  errors: ['not_found', 'invalid'],
  req: req({ artifactId: ArtifactIdSchema, path: z.string().max(1024) }),
  res: z.object({ url: z.string(), expiresAt: MillisSchema }),
});

export const artifactFileList = defineCommand({
  name: 'artifactFileList',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['artifacts:read', 'artifacts:write'],
  source: 'extra',
  permission:
    "Anyone with a role. path is a prefix in the artifact's own view; lists recursively, at most 1000.",
  errors: ['not_found', 'invalid'],
  req: req({ artifactId: ArtifactIdSchema, path: z.string().max(1024).default('') }),
  res: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        size: z.number().int(),
        contentType: z.string().nullable(),
        updatedAt: MillisSchema,
      }),
    ),
  }),
});

export const artifactFileDelete = defineCommand({
  name: 'artifactFileDelete',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['artifacts:write'],
  source: 'extra',
  permission: 'Whoever may write data (artifactCan.writeData).',
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({ artifactId: ArtifactIdSchema, path: z.string().max(1024) }),
  res: OkResSchema,
});

/** The source zip of a build (the newest with one, unless buildId). */
export const artifactSourceUrl = defineCommand({
  name: 'artifactSourceUrl',
  source: 'extra',
  scopes: ['artifacts:read', 'artifacts:write'],
  permission: 'Owner or editor, or an agent with build on it (§AA3).',
  errors: ['not_found', 'forbidden'],
  req: req({ artifactId: ArtifactIdSchema, buildId: ArtifactBuildIdSchema.optional() }),
  res: z.object({ url: z.string(), buildId: ArtifactBuildIdSchema, expiresAt: MillisSchema }),
});

/** The owner's Data tab (§F): delete every document, RTDB node and file under the prefix. */
export const artifactDataClear = defineCommand({
  name: 'artifactDataClear',
  // MCP (the Claude app as the whole UI): reachable by a token with these scopes.
  scopes: ['artifacts:write'],
  source: 'extra',
  permission: 'Owner only. Builds and people are untouched.',
  errors: ['not_found', 'forbidden'],
  req: req({ artifactId: ArtifactIdSchema }),
  res: OkResSchema,
});
