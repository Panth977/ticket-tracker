/**
 * apiKeyCreate v2 (docs/plan/agents.html §E) — Account › Tokens › New token.
 *
 * PHASE 10 (§R1) adds kind 'account' — "virtual me". It names no board, always
 * acts as the caller, and may carry the account scopes. Everything below about
 * one board applies to kind 'board' only, which is unchanged.
 *
 * kind 'board': ONE BOARD, ONE PRINCIPAL. A token names exactly one board the person is on,
 * and acts either as that person or as one of THEIR agents that is on that
 * board. Its changes are authored by that principal and read
 * 'Builder (agent) via token orch-eng-builder'.
 *
 * Scopes only NARROW: what the token may do is its scopes ∩ can() for the
 * acting principal on that board, evaluated per request. Admin scopes
 * (board:admin, webhooks:manage) are refused for agent tokens (the schema
 * says so) and need the person to be an admin of the board today.
 *
 * Stored as sha256 at users/{uid}/apiKeys/{keyId}; the clear key is returned
 * exactly once. The middleware (middleware/apiKey.ts) re-checks board, owner
 * and agent on every request, so removing either one stops the token.
 *
 * §AA1 (agents.html) adds kind 'agent' — ONE TOKEN PER AGENT. It names the
 * agent (actsAs) and nothing else: no board, no scopes (always
 * AGENT_TOKEN_SCOPES). The agent must be the caller's and not archived; it
 * need not be on any board yet — the token reaches whatever the agent is on
 * at each call. GENERATING A NEW ONE REPLACES THE OLD: in the same
 * transaction that writes the new row, every other live token acting as that
 * agent (agent tokens and legacy board tokens alike) is revoked with
 * revokedReason 'rotated' — unless keepOthers, which the migration uses
 * (§AA6) and which the owner may use for a deliberate overlap.
 *
 * A board token acting as an agent can still be created (the pre-§AA form):
 * existing orchestrators and the SDK mint them, and the middleware resolves
 * them as before. The app no longer offers it (§AA5).
 *
 * A TOKEN IS NEVER MADE BY A TOKEN: apiKeyCreate is on TOKEN_DENIED_COMMANDS,
 * so the runner refuses it for any credential carrying scopes, whatever they
 * are. That is what keeps a leak from becoming permanent (§R1).
 */
import {
  ADMIN_SCOPES,
  ctxOwner,
  DEFAULT_API_KEY_LIMITS,
  errors,
  isAgentId,
  paths,
  type Agent,
  type ApiKey,
  type Board,
  type Scope,
} from '@tm/shared';
import { roleOf } from '@tm/shared/logic/index';
import { agentRef } from '../agents/shared.js';
import { agentKeyDoc, mintApiKey } from '../platform/apiKeyMint.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { runTx, txGet } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';

const DAY = 86_400_000;

export default defineCommand('apiKeyCreate', async (ctx, input) => {
  // Tokens are made by a person in the app, never by another token or an agent.
  if (isAgentId(ctx.actor)) throw errors.forbidden('Agents cannot create tokens');
  const owner = ctxOwner(ctx);

  const expiresAt = input.expiresInDays ? ctx.now + input.expiresInDays * DAY : null;

  if (input.kind === 'agent') {
    // The request schema guarantees actsAs is an agent, no boardId, no scopes.
    if (input.actsAs.kind !== 'agent') throw errors.invalid('Name the agent', { field: 'actsAs' });
    const agentId = input.actsAs.id;
    const minted = mintApiKey();
    const keyId = ctx.ids.id();
    const rotated = await runTx(async (tx) => {
      // ── reads ──
      const agent = await txGet(tx, agentRef(agentId));
      // Agents are private to their owner: someone else's agent is simply not found.
      if (!agent || agent.ownerUid !== owner) throw errors.not_found('Agent not found');
      if (agent.archivedAt !== null)
        throw errors.invalid('This agent is archived', { field: 'actsAs' });
      // Every token acting as this agent lives under its owner (only the
      // owner can mint one) — read in the transaction, so two "Regenerate"
      // clicks at once cannot both leave a live token behind.
      const others = input.keepOthers
        ? []
        : (
            await tx.get(typedCol('apiKeys', paths.apiKeys(owner)).where('actsAs.id', '==', agentId))
          ).docs.filter((d) => d.data().revokedAt === null);
      // ── writes ──
      for (const d of others) tx.update(d.ref, { revokedAt: ctx.now, revokedReason: 'rotated' });
      tx.create(
        typedDoc('apiKeys', paths.apiKey(owner, keyId)),
        agentKeyDoc({ name: input.name, agentId, ...minted, now: ctx.now, expiresAt }),
      );
      return others.length;
    });
    return { key: minted.key, keyId, prefix: minted.prefix, expiresAt, rotated };
  }

  const account = input.kind === 'account';
  // Required for 'board' and 'account' by the request schema.
  const scopes: Scope[] = [...new Set(input.scopes ?? [])];
  // The request schema already refuses account scopes on a board token and a
  // boardId / agent on an account token; this is the data side of the rules.
  const boardId = account ? null : input.boardId!;

  if (!account) {
    const [boardSnap, agentSnap] = await Promise.all([
      db().doc(paths.board(boardId!)).get(),
      input.actsAs.kind === 'agent'
        ? db().doc(paths.agent(input.actsAs.id)).get()
        : Promise.resolve(null),
    ]);
    const board = boardSnap.exists ? (boardSnap.data() as Board) : undefined;
    // A board you are not on and a board that does not exist look the same.
    const role = board ? roleOf(board, owner) : null;
    if (!board || !role) throw errors.not_found('Board not found');

    const admin = scopes.filter((s) => (ADMIN_SCOPES as readonly string[]).includes(s));
    if (admin.length && role !== 'admin')
      throw errors.forbidden('Only a board admin can give a token admin scopes', { scopes: admin });

    if (input.actsAs.kind === 'agent') {
      const agentId = input.actsAs.id;
      const agent = agentSnap?.exists ? (agentSnap.data() as Agent) : undefined;
      // Agents are private to their owner: someone else's agent is simply not found.
      if (!agent || agent.ownerUid !== owner) throw errors.not_found('Agent not found');
      if (agent.archivedAt !== null)
        throw errors.invalid('This agent is archived', { field: 'actsAs' });
      if (!roleOf(board, agentId))
        throw errors.invalid('Add the agent to this board first (People & roles › Add agent)', {
          field: 'actsAs',
        });
    }
  }
  /*
   * An account token has NO board to check an admin scope against at creation
   * time, so the check moves to where it belongs: can() asks, on every single
   * request, whether this person is an admin of THAT board. A scope never
   * widens a role, so carrying board:admin on boards where you are only an
   * editor buys nothing.
   */

  const { key, prefix, hash } = mintApiKey();
  const keyId = ctx.ids.id();
  const doc: ApiKey = {
    name: input.name,
    kind: input.kind,
    boardId,
    actsAs:
      input.actsAs.kind === 'agent'
        ? { kind: 'agent', id: input.actsAs.id }
        : { kind: 'user', id: owner },
    scopes,
    prefix,
    hash,
    limits: { ...DEFAULT_API_KEY_LIMITS },
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
    revokedReason: null,
    createdAt: ctx.now,
  };
  await typedDoc('apiKeys', paths.apiKey(owner, keyId)).create(doc);
  return { key, keyId, prefix: doc.prefix, expiresAt };
});
