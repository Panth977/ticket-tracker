/**
 * ENVS — key/value settings on a board, artifact, bucket, agent or org,
 * mostly for orchestrators: the workspaces orch hands its agents the
 * effective env of their board and of the agent itself as process
 * environment. Plain text (not secrets): anyone who may edit the thing sees
 * them, and so do its agents.
 *
 *   _env/{kind}:{id}   { vars, updatedAt, updatedBy }   server-only
 *
 * Inheritance: a thing that belongs to an org gets the org's vars, its own
 * winning (effective = { ...org, ...own }). An agent's env is its own.
 */
import { z } from 'zod';
import { defineCommand, req } from '../commands/define.js';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ENV_VALUE_MAX = 4096;
export const ENV_PAIRS_MAX = 100;
export const ENV_KINDS = ['board', 'artifact', 'bucket', 'agent', 'org'] as const;
export type EnvKind = (typeof ENV_KINDS)[number];

export const EnvKeySchema = z
  .string()
  .regex(ENV_KEY_RE, 'Letters, digits and _ ; not starting with a digit; at most 64');
export const EnvVarsSchema = z
  .record(EnvKeySchema, z.string().max(ENV_VALUE_MAX))
  .refine((v) => Object.keys(v).length <= ENV_PAIRS_MAX, `At most ${ENV_PAIRS_MAX} pairs`);
export type EnvVars = z.infer<typeof EnvVarsSchema>;

export const EnvTargetSchema = z.object({
  kind: z.enum(ENV_KINDS),
  /** Board id or KEY, artifact / bucket / agent / org id. */
  id: z.string().min(1).max(64),
});
export type EnvTarget = z.infer<typeof EnvTargetSchema>;

/** _env/{kind}:{id} */
export const envDocPath = (kind: EnvKind, id: string) => `_env/${kind}:${id}`;

const EnvOutSchema = z.object({
  /** This thing's own pairs. */
  vars: EnvVarsSchema,
  /** What it inherits (its org's), before its own. */
  inherited: EnvVarsSchema,
  /** { ...inherited, ...vars } — what an orchestrator uses. */
  effective: EnvVarsSchema,
  updatedAt: z.number().nullable(),
});

export const envGet = defineCommand({
  name: 'envGet',
  source: 'extra',
  scopes: ['board:read', 'artifacts:read', 'bucket:read'],
  permission:
    "Who may edit the thing: a board's editors and admins, an artifact's or bucket's owner and editors, an agent's owner, an org's admins — and the thing's own agents (an agent on the board, an agent on the artifact, the agent itself).",
  errors: ['not_found', 'forbidden'],
  req: req({ target: EnvTargetSchema }),
  res: EnvOutSchema,
});

export const envSet = defineCommand({
  name: 'envSet',
  source: 'extra',
  scopes: ['board:admin', 'artifacts:write', 'bucket:write', 'agents:write'],
  permission:
    "A board's admins, an artifact's or bucket's owner, an agent's owner, an org's admins. People only — never an agent.",
  errors: ['not_found', 'forbidden', 'invalid'],
  req: req({
    target: EnvTargetSchema,
    /** Pairs to set; a null value removes that key. */
    set: z.record(EnvKeySchema, z.string().max(ENV_VALUE_MAX).nullable()).optional(),
    /** Instead: the whole new set of pairs. */
    replace: EnvVarsSchema.optional(),
  }).refine((r) => (r.set === undefined) !== (r.replace === undefined), 'Give set or replace'),
  res: EnvOutSchema,
});
