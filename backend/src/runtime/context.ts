/**
 * The context a command handler receives. It is the shared CommandCtx (who,
 * through which door, when) plus the id generator — so handlers never call
 * Date.now() or Math.random() and tests can pin both.
 *
 * Other ports (email, queue, search …) are reached through `ports()` from
 * '../adapters/index.js'; notify / emitWebhook through their own modules.
 */
import type { CommandCtx, IdGen } from '@tm/shared';
import { ports } from '../adapters/index.js';

export interface ServerCtx extends CommandCtx {
  ids: IdGen;
}

/** Build a ServerCtx: `now` from the clock port unless given, `ids` from the ids port. */
export function makeCtx(base: Omit<CommandCtx, 'now'> & { now?: number }): ServerCtx {
  const p = ports();
  return { ...base, now: base.now ?? p.clock.now(), ids: p.ids };
}
