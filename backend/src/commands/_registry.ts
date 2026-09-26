/**
 * THE BACKEND COMMAND REGISTRY. A command is one file in src/commands/:
 *
 *   // src/commands/boardCreate.ts
 *   import { defineCommand } from './_registry.js';
 *   export default defineCommand('boardCreate', async (ctx, input) => { … return res; });
 *
 * The name must be a key of the shared COMMANDS contract, which supplies the
 * Req / Res zod schemas, so `input` and the return type are typed from it.
 * Every file in this directory (except `_*` and tests) is imported at cold
 * start by runtime/autoload.ts — that import IS the registration. Authors
 * never touch HTTP: the runner parses, checks scopes, handles idempotency and
 * maps errors to problem+json for every door.
 */
import type { z } from 'zod';
import {
  COMMANDS,
  type CommandName,
  type CommandReqParsed,
  type CommandRes,
  type CommandSpec,
} from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';

export type CommandHandler<N extends CommandName> = (
  ctx: ServerCtx,
  input: CommandReqParsed<N>,
) => Promise<CommandRes<N>>;

export interface RegisteredCommand {
  spec: CommandSpec;
  handler: (ctx: ServerCtx, input: unknown) => Promise<unknown>;
  /** Not in the shared COMMANDS contract (e.g. `ping`); still reachable at /api/{name}. */
  local: boolean;
}

const registry = new Map<string, RegisteredCommand>();

function register(
  spec: CommandSpec,
  handler: RegisteredCommand['handler'],
  local: boolean,
): RegisteredCommand {
  if (registry.has(spec.name)) throw new Error(`Command "${spec.name}" registered twice`);
  const entry = { spec, handler, local };
  registry.set(spec.name, entry);
  return entry;
}

/** Register the handler for a contract command. */
export function defineCommand<N extends CommandName>(
  name: N,
  handler: CommandHandler<N>,
): RegisteredCommand {
  const spec = COMMANDS[name] as CommandSpec | undefined;
  if (!spec) throw new Error(`defineCommand: "${name}" is not in the shared COMMANDS registry`);
  return register(spec, handler as RegisteredCommand['handler'], false);
}

/**
 * Register a backend-only command with its own spec — for operational
 * commands that are not part of the app contract (only `ping` today). Prefer
 * adding the command to shared COMMANDS instead.
 */
export function defineLocalCommand<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  spec: CommandSpec<string, Req, Res>,
  handler: (ctx: ServerCtx, input: z.output<Req>) => Promise<z.input<Res>>,
): RegisteredCommand {
  return register(spec as CommandSpec, handler as RegisteredCommand['handler'], true);
}

/** A Map, so names like 'constructor' or '__proto__' can never resolve. */
export const getRegisteredCommand = (name: string): RegisteredCommand | undefined =>
  registry.get(name);

export const registeredCommandNames = (): string[] => [...registry.keys()];

/** Contract commands with no handler yet (reported by /api/_status in dev; asserted by integration). */
export const unimplementedCommands = (): CommandName[] =>
  (Object.keys(COMMANDS) as CommandName[]).filter((n) => !registry.has(n));
