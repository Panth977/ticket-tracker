/**
 * ARTIFACTS (docs/plan/artifacts.html) — the stored shapes.
 *
 *   artifacts/{id}                          ArtifactSchema
 *   artifacts/{id}/builds/{buildId}         ArtifactBuildSchema
 *   artifacts/{id}/db/data/…                the artifact's own Firestore (anything)
 *   artifacts/{id}/viewers/{uid}/kv/{key}   ArtifactKvSchema (db.kv)
 *   RTDB /artifactData/{id}/…               the artifact's own RTDB (anything)
 *   RTDB /artifactReaders/{id}/{uid}        role, mirrored from access by a trigger
 *
 * AGENTS ON AN ARTIFACT (agents.html §AA3): `agents[agentId]` is
 * { build, data } — two permissions, separately. See ArtifactAgentAccessSchema.
 *
 * An artifact is NOT a board: its people are its own (§B), and being on a
 * board gives nothing here.
 */
import { z } from 'zod';
import { DESCRIPTION_MAX, IndicatorSchema } from '../types/indicator.js';
import {
  AgentIdSchema,
  BoardIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  UidSchema,
} from '../types/index.js';

export const ARTIFACT_ROLES = ['owner', 'editor', 'viewer'] as const;
export const ArtifactRoleSchema = z.enum(ARTIFACT_ROLES);
export type ArtifactRole = z.infer<typeof ArtifactRoleSchema>;
/** A role that may be GIVEN by sharing — there is exactly one owner, set at create. */
export const ArtifactShareRoleSchema = z.enum(['editor', 'viewer']);
export type ArtifactShareRole = z.infer<typeof ArtifactShareRoleSchema>;

/** Firestore auto ids (20) — also accepted: anything URL-safe up to 64. */
export const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Artifact id');
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export const ArtifactBuildIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Build id');
export type ArtifactBuildId = z.infer<typeof ArtifactBuildIdSchema>;

/**
 * §AA3 — WHAT AN AGENT MAY DO ON ONE ARTIFACT: build and data, separately.
 *
 *   build   publish, roll back, download the source
 *   data    'none' | 'read' | 'write' — the artifact's database and files,
 *           through the data API (§AA4)
 *
 * Any of them lets the agent list the artifact and read its description. At
 * least one must be given: { build: false, data: 'none' } means "not on it"
 * and is never stored (artifactShare treats it as remove).
 *
 * An agent never OWNS an artifact and never shares, renames or deletes one.
 */
export const ARTIFACT_AGENT_DATA = ['none', 'read', 'write'] as const;
export const ArtifactAgentDataSchema = z.enum(ARTIFACT_AGENT_DATA);
export type ArtifactAgentData = z.infer<typeof ArtifactAgentDataSchema>;
export const ArtifactAgentAccessSchema = z
  .object({ build: z.boolean(), data: ArtifactAgentDataSchema })
  .strict();
export type ArtifactAgentAccess = z.infer<typeof ArtifactAgentAccessSchema>;
/**
 * What is STORED at artifacts/{id}.agents[agentId]: the object — or the
 * literal 'editor', which is what every row said before §AA3 and which reads
 * as { build: true, data: 'write' }. Writers store the OBJECT from now on;
 * scripts/migrate-agent-tokens.mjs rewrites the old rows (§AA6).
 */
export const ArtifactAgentStoredSchema = z.union([ArtifactAgentAccessSchema, z.literal('editor')]);
export type ArtifactAgentStored = z.infer<typeof ArtifactAgentStoredSchema>;
/** What 'editor' meant, and what an agent gets on an artifact it creates. */
export const ARTIFACT_AGENT_FULL: ArtifactAgentAccess = Object.freeze({
  build: true,
  data: 'write',
}) as ArtifactAgentAccess;
/** "Not on it" — never stored. */
export const ARTIFACT_AGENT_NONE: ArtifactAgentAccess = Object.freeze({
  build: false,
  data: 'none',
}) as ArtifactAgentAccess;

/**
 * Either stored form → { build, data }. Pure and total: 'editor' is the old
 * form; anything else that is not a well-formed object (absent, null, a
 * stray value) is ARTIFACT_AGENT_NONE — never an error, and never more than
 * what the document says.
 */
export function agentAccessOf(value: unknown): ArtifactAgentAccess {
  if (value === 'editor') return { ...ARTIFACT_AGENT_FULL };
  if (!value || typeof value !== 'object') return { ...ARTIFACT_AGENT_NONE };
  const v = value as { build?: unknown; data?: unknown };
  return {
    build: v.build === true,
    data: v.data === 'read' || v.data === 'write' ? v.data : 'none',
  };
}
/** { build: false, data: 'none' } — "remove the agent". */
export const agentAccessIsNone = (a: ArtifactAgentAccess): boolean => !a.build && a.data === 'none';

/**
 * The agent-side answers (§AA3). Each takes EITHER stored form (or
 * undefined for "not on it"), so callers never normalise by hand.
 *   canOpen       list it, read its description, builds and members
 *   canBuild      publish, roll back, download the source
 *   canReadData   read its database and files through the data API
 *   canWriteData  … and write them
 */
export const canOpenArtifact = (v: unknown): boolean => !agentAccessIsNone(agentAccessOf(v));
export const canBuild = (v: unknown): boolean => agentAccessOf(v).build;
export const canReadData = (v: unknown): boolean => agentAccessOf(v).data !== 'none';
export const canWriteData = (v: unknown): boolean => agentAccessOf(v).data === 'write';
export const artifactAgentCan = {
  open: canOpenArtifact,
  build: canBuild,
  readData: canReadData,
  writeData: canWriteData,
  /** An agent never owns, shares, renames or deletes an artifact. */
  manage: (_v: unknown): boolean => false,
} as const;

export const ARTIFACT_NAME_MAX = 80;
/** indicators.html: the one description limit. */
export const ARTIFACT_DESCRIPTION_MAX = DESCRIPTION_MAX;
/** §C1 limits on one build. */
export const ARTIFACT_BUILD_MAX_BYTES = 25 * 1024 * 1024;
export const ARTIFACT_BUILD_MAX_FILES = 2000;
/** MCP publishes files inline: at most this much in one call (§C2). */
export const ARTIFACT_INLINE_MAX_BYTES = 5 * 1024 * 1024;
/** Builds kept per artifact; older ones (never the current) go in housekeeping. */
export const ARTIFACT_BUILDS_KEPT = 10;
/** §E4: one upload through db.storage. */
export const ARTIFACT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** How long an artifactOpen capability lives (§D2). */
export const ARTIFACT_CAPABILITY_TTL_MS = 60 * 60 * 1000;
/** Live listeners one artifact tab may hold through the broker (§E3). */
export const ARTIFACT_MAX_LISTENERS = 50;
/**
 * The ZIP a build arrives in (compressed): a little over the 25 MB a build may
 * unpack to, because a folder of already-compressed assets barely shrinks.
 * Storage rules and the REST door both refuse a larger one.
 */
export const ARTIFACT_ZIP_MAX_BYTES = 26 * 1024 * 1024;
/** The optional source zip kept beside a build (never served, never unpacked). */
export const ARTIFACT_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
/** uploads/ zips nobody published are swept after this long (housekeeping). */
export const ARTIFACT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * INVITES AND INBOX ROWS ABOUT AN ARTIFACT. Both documents predate artifacts
 * and require a board id (and an invite a board key). An artifact has neither,
 * so those rows carry these fixed values and say which artifact they mean in
 * `artifactId` — that field, not the board id, is what tells them apart. No
 * real board can have this id (board ids are 20-char auto ids).
 */
export const ARTIFACT_INVITE_BOARD_ID = '_artifacts';
export const ARTIFACT_INVITE_BOARD_KEY = 'ARTF';

/**
 * §K — what the owner lets the artifact do with a BOARD's tickets. A ceiling,
 * never a key: the host page's broker reads and writes as the VIEWER, so the
 * viewer's own role on that board (and the rules behind it) still decides.
 */
export const ARTIFACT_BOARD_ACCESS = ['read', 'write'] as const;
export const ArtifactBoardAccessSchema = z.enum(ARTIFACT_BOARD_ACCESS);
export type ArtifactBoardAccess = z.infer<typeof ArtifactBoardAccessSchema>;
/** Boards one artifact may be granted. */
export const ARTIFACT_BOARDS_MAX = 20;

export const ArtifactSchema = z.object({
  name: z.string().min(1).max(ARTIFACT_NAME_MAX),
  description: z.string().max(ARTIFACT_DESCRIPTION_MAX).nullable(),
  /** LEGACY (indicators.html): one typed emoji. Read through indicatorOf(). */
  icon: z.string().max(16).nullable(),
  /** indicators.html: what the sidebar, dropdowns and cards draw. */
  indicator: IndicatorSchema.optional(),
  ownerUid: UidSchema,
  /** Every PERSON with a role, the owner included. Rules read this. */
  access: z.record(UidSchema, ArtifactRoleSchema),
  /**
   * The keys of `access`, DERIVED by the commands and never written on its
   * own (like a board's readerUids). It exists for one reason: a list query
   * has to be provable from the query alone, and
   * `where('memberUids', 'array-contains', uid)` is — a map key is not.
   */
  memberUids: z.array(UidSchema),
  /**
   * Agents on it (§AA3): { build, data } each. The literal 'editor' is the
   * pre-§AA form and reads as { build: true, data: 'write' } (agentAccessOf).
   */
  agents: z.record(AgentIdSchema, ArtifactAgentStoredSchema),
  /**
   * §K: boards whose tickets the page may use through the driver
   * (BackendDriver.tickets), set by the owner with artifactBoardAccessSet.
   * Absent on artifacts made before §K = none.
   */
  boards: z.record(BoardIdSchema, ArtifactBoardAccessSchema).optional(),
  /** §B: viewers may read the data but not write it. */
  readOnly: z.boolean(),
  archivedAt: MillisSchema.nullable(),
  /** null until the first publish (the host shows "nothing published yet"). */
  currentBuild: z.string().nullable(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
  /**
   * Set by artifactDelete the moment it is asked: access, agents and
   * memberUids are emptied in the same write (so nobody can read it, or its
   * data, from then on) and the queued job removes everything, this document
   * last. Absent on a live artifact.
   */
  deletingAt: MillisSchema.nullable().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactBuildSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  message: z.string().max(500).nullable(),
  /** Storage path of the source zip (artifacts/{id}/source/{buildId}.zip), when one came with it. */
  sourcePath: z.string().nullable(),
  /** Who published: a uid, or an agent id. */
  by: PrincipalIdSchema,
  createdAt: MillisSchema,
  /** e.g. the absolute-asset-path warning of §C1. */
  warnings: z.array(z.string()),
});
export type ArtifactBuild = z.infer<typeof ArtifactBuildSchema>;

export const ArtifactKvSchema = z.object({ value: z.unknown(), updatedAt: MillisSchema });
export type ArtifactKv = z.infer<typeof ArtifactKvSchema>;

/** What a role may do (§B table). The rules and every handler use the same answers. */
export const artifactCan = {
  open: (r: ArtifactRole | null | undefined): boolean => !!r,
  readData: (r: ArtifactRole | null | undefined): boolean => !!r,
  writeData: (r: ArtifactRole | null | undefined, readOnly: boolean): boolean =>
    r === 'owner' || r === 'editor' || (r === 'viewer' && !readOnly),
  publish: (r: ArtifactRole | null | undefined): boolean => r === 'owner' || r === 'editor',
  manage: (r: ArtifactRole | null | undefined): boolean => r === 'owner',
};
