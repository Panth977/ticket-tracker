/**
 * How the inbound hooks reach commands: through the same runner every door
 * uses (scopes, zod, idempotency by clientId, can() inside the handler).
 * Indirected so tests can observe the calls without the ticket commands
 * (owned by another step) being present.
 */
import type { CommandCtx } from '@tm/shared';
import { makeCtx, type ServerCtx } from '../runtime/context.js';
import { runCommand } from '../runtime/runner.js';

export type CommandInvoker = (name: string, input: unknown, ctx: ServerCtx) => Promise<unknown>;

const defaultInvoker: CommandInvoker = (name, input, ctx) => runCommand(name, input, ctx);
let invoker: CommandInvoker = defaultInvoker;

/** Run a command as a hook (via 'email' / 'whatsapp'). */
export function invokeCommand(
  name: string,
  input: unknown,
  base: Omit<CommandCtx, 'now'> & { now?: number },
): Promise<unknown> {
  return invoker(name, input, makeCtx(base));
}

/** Tests: observe / fake command calls. No argument restores the real runner. */
export function setCommandInvoker(fn?: CommandInvoker): void {
  invoker = fn ?? defaultInvoker;
}
