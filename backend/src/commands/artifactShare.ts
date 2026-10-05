/**
 * artifactShare (docs/plan/artifacts.html §B) — OWNER ONLY. Exactly one of:
 *
 *   email    a person, role 'editor' | 'viewer' (null removes them)
 *     · has an account            → access[uid] = role at once, and an inbox
 *                                    row tells them          → 'granted'
 *     · no account yet            → an invite in the same top-level invites/
 *                                    flow boards use, carrying `artifactId`;
 *                                    it waits for their sign-in and is
 *                                    accepted with inviteAccept → 'invited'
 *   agentId  one of the artifact OWNER's agents, with WHAT IT MAY DO HERE
 *            (agents.html §AA3): agentAccess { build, data }. At least one
 *            must be given — { build: false, data: 'none' } removes the
 *            agent. The pre-§AA form still works: role 'editor' is
 *            { build: true, data: 'write' }, role null removes. agentAccess
 *            wins when both are given. What is STORED is always the object.
 *
 * NEVER AN AGENT (§AA3): an agent never shares an artifact. 'manage' answers
 * that for any agent (artifacts/shared.ts), whatever it holds.
 *
 * THE OWNER'S OWN ROLE CANNOT BE CHANGED (409): there is exactly one owner,
 * set at create, and sharing can neither demote nor remove them.
 *
 * THE ALLOW LIST (agents.html §X) applies here as everywhere: an account the
 * admin has not allowed can never be given a role — that would put someone in
 * `access` whom every rule then refuses, which reads as a bug rather than a
 * decision. An address with NO account may still be invited; whether they get
 * in is decided when they arrive.
 *
 * After the commit: the RTDB mirror (the database rules read it), then the
 * mail / inbox row. 'Shared with you' is an IN-APP row only — notify()'s
 * router is board-shaped (per-board prefs, roles, watchers) and an artifact
 * has none, so push and e-mail for it are not wired.
 */
import {
  agentAccessIsNone,
  ARTIFACT_AGENT_FULL,
  ARTIFACT_AGENT_NONE,
  ARTIFACT_INVITE_BOARD_ID,
  ARTIFACT_INVITE_BOARD_KEY,
  errors,
  INVITE_TTL_MS,
  paths,
  rateBuckets,
  type ArtifactAgentAccess,
  type ArtifactRole,
  type ArtifactShareRole,
  type Invite,
} from '@tm/shared';
import { agentRef } from '../agents/shared.js';
import {
  artifactInboxRow,
  artifactRef,
  loadArtifact,
  syncArtifactMirror,
  withMembers,
} from '../artifacts/shared.js';
import { assertAllowedOwner } from '../platform/allow.js';
import type { ServerCtx } from '../runtime/context.js';
import { typedCol, typedDoc } from '../runtime/converters.js';
import { runTx, txGet, type Tx } from '../runtime/tx.js';
import { defineCommand } from './_registry.js';
import { INVITES_PER_DAY, profileOf, sha256, takeRate } from './boardShared.js';
import { inviteInboxRef, inviteRef, isLive, sendInviteEmail, uidForEmail } from './inviteShared.js';

type Outcome = 'granted' | 'invited' | 'removed';
const done = (outcome: Outcome) => ({ ok: true as const, outcome });

const ROLE_WORDS: Record<ArtifactShareRole, string> = { editor: 'an editor', viewer: 'a viewer' };
const has = (map: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(map, key);

/** Pending invites to this artifact for this address (normally none or one). */
async function pendingInvites(artifactId: string, email: string) {
  const snap = await typedCol('invites', paths.invites())
    .where('artifactId', '==', artifactId)
    .where('email', '==', email)
    .where('status', '==', 'pending')
    .get();
  return snap.docs;
}

/** The 'invited' inbox rows that EXIST for these invites (a transaction reads before it writes). */
async function inviteRows(tx: Tx, uid: string | null, invites: { id: string }[]) {
  if (!uid) return [];
  const refs = invites.map((d) => inviteInboxRef(uid, d.id));
  const found = await Promise.all(refs.map((r) => txGet(tx, r)));
  return refs.filter((_, i) => found[i] !== undefined);
}

/** What was asked for an agent: agentAccess, else the old role form ('editor' → both, null → none). */
function wantedAgentAccess(input: {
  role?: ArtifactShareRole | null | undefined;
  agentAccess?: ArtifactAgentAccess | undefined;
}): ArtifactAgentAccess {
  if (input.agentAccess) return { build: input.agentAccess.build, data: input.agentAccess.data };
  if (input.role === 'editor') return { ...ARTIFACT_AGENT_FULL };
  if (input.role === null) return { ...ARTIFACT_AGENT_NONE };
  // The request schema refuses the rest ('viewer', or neither given).
  throw errors.invalid('Give agentAccess { build, data } for the agent', { field: 'agentAccess' });
}

async function shareAgent(
  ctx: ServerCtx,
  artifactId: string,
  agentId: string,
  want: ArtifactAgentAccess,
) {
  // §AA3: "at least one must be given" — nothing given is "remove the agent".
  const remove = agentAccessIsNone(want);
  await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
    const agent = await txGet(tx, agentRef(agentId));
    const agents = { ...artifact.agents };
    if (remove) {
      if (!has(agents, agentId)) return;
      delete agents[agentId];
    } else {
      // Someone else's agent and a missing one look the same: agents are private.
      if (!agent || agent.ownerUid !== artifact.ownerUid) throw errors.not_found('Agent not found');
      if (agent.archivedAt !== null)
        throw errors.conflict('This agent is archived — restore it first');
      const stored = has(agents, agentId) ? agents[agentId] : undefined;
      // Unchanged AND already in the object form: nothing to write. A stored
      // legacy 'editor' is rewritten even when it means the same thing —
      // writers always store the object from §AA3 on.
      if (
        stored &&
        typeof stored === 'object' &&
        stored.build === want.build &&
        stored.data === want.data
      )
        return;
      agents[agentId] = want;
    }
    tx.update(artifactRef(artifactId), { agents, updatedAt: ctx.now });
  });
  return done(remove ? 'removed' : 'granted');
}

async function removePerson(ctx: ServerCtx, artifactId: string, email: string, uid: string | null) {
  const stale = await pendingInvites(artifactId, email);
  const next = await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
    if (uid && uid === artifact.ownerUid)
      throw errors.conflict("The owner's own role cannot be changed");
    // An invite still waiting for them is withdrawn with the access (and its
    // inbox row, when they had signed up and been shown one). Reads first.
    const rows = await inviteRows(tx, uid, stale);
    for (const d of stale) tx.update(d.ref, { status: 'revoked' });
    for (const ref of rows) tx.update(ref, { archivedAt: ctx.now });
    if (!uid || !has(artifact.access, uid)) return null;
    const access = { ...artifact.access };
    delete access[uid];
    const members = withMembers(access);
    tx.update(artifactRef(artifactId), { ...members, updatedAt: ctx.now });
    return { ...artifact, ...members };
  });
  if (next) await syncArtifactMirror(artifactId, next);
  return done('removed');
}

async function grantPerson(
  ctx: ServerCtx,
  artifactId: string,
  email: string,
  uid: string,
  role: ArtifactShareRole,
) {
  // §X — checked before the write, outside the transaction (it reads the list).
  try {
    await assertAllowedOwner(uid);
  } catch {
    throw errors.conflict(
      `${email} is not allowed to use this TaskManager yet — the admin has to add them first`,
      { reason: 'notAllowed', email },
    );
  }
  const stale = await pendingInvites(artifactId, email);
  const res = await runTx(async (tx) => {
    const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
    if (uid === artifact.ownerUid) throw errors.conflict("The owner's own role cannot be changed");
    const before: ArtifactRole | undefined = has(artifact.access, uid)
      ? artifact.access[uid]
      : undefined;
    // They have an account now: an invite that was waiting is settled by this.
    const rows = await inviteRows(tx, uid, stale);
    for (const d of stale) tx.update(d.ref, { status: 'accepted' });
    for (const ref of rows) tx.update(ref, { readAt: ctx.now, archivedAt: ctx.now });
    if (before === role) return { artifact, changed: false };
    const members = withMembers({ ...artifact.access, [uid]: role });
    tx.update(artifactRef(artifactId), { ...members, updatedAt: ctx.now });
    return { artifact: { ...artifact, ...members }, changed: true };
  });
  if (res.changed) {
    await syncArtifactMirror(artifactId, res.artifact);
    const by = (await profileOf(ctx.actor)).name;
    await typedDoc('inbox', paths.inboxItem(uid, `artifact_${artifactId}`))
      .set(
        artifactInboxRow(
          artifactId,
          'invited',
          `${by} shared the artifact “${res.artifact.name}” with you as ${ROLE_WORDS[role]}`,
          ctx,
        ),
      )
      .catch((e) => console.warn('[artifactShare] inbox row failed', e));
  }
  return done('granted');
}

async function invitePerson(
  ctx: ServerCtx,
  artifactId: string,
  email: string,
  role: ArtifactShareRole,
) {
  const existing = (await pendingInvites(artifactId, email))[0]?.id;
  const inviter = await profileOf(ctx.actor);
  const token = ctx.ids.token(32);
  const newId = ctx.ids.id();
  // The same daily allowance as board invites: it is the same mail.
  const refund = await takeRate(rateBuckets.invites(ctx.actor), INVITES_PER_DAY, ctx.now);
  let sent: { id: string; inv: Invite };
  try {
    sent = await runTx(async (tx) => {
      const { artifact } = await loadArtifact(tx, artifactId, ctx, 'manage');
      const prev = existing ? await txGet(tx, inviteRef(existing)) : undefined;
      // A live invite is refreshed (new token, expiry, role), never duplicated.
      const refresh = !!prev && isLive(prev, ctx.now);
      const id = refresh ? existing! : newId;
      if (prev && !refresh) tx.update(inviteRef(existing!), { status: 'expired' });
      const inv: Invite = {
        boardId: ARTIFACT_INVITE_BOARD_ID,
        boardName: artifact.name,
        boardKey: ARTIFACT_INVITE_BOARD_KEY,
        email,
        role,
        invitedBy: ctx.actor,
        invitedByName: inviter.name,
        message: null,
        tokenHash: sha256(token),
        status: 'pending',
        expiresAt: ctx.now + INVITE_TTL_MS,
        createdAt: refresh ? prev!.createdAt : ctx.now,
        artifactId,
      };
      tx.set(inviteRef(id), inv);
      return { id, inv };
    });
  } catch (e) {
    await refund();
    throw e;
  }
  await sendInviteEmail(sent.inv, sent.id, token, ctx.email ?? inviter.email);
  return done('invited');
}

export default defineCommand('artifactShare', async (ctx, input) => {
  const { artifactId } = input;
  if ((input.email === undefined) === (input.agentId === undefined))
    throw errors.invalid('Give exactly one of email or agentId');
  // Gate first, so a caller without the right never learns whether an address has an account.
  await loadArtifact(null, artifactId, ctx, 'manage');

  if (input.agentId)
    return shareAgent(ctx, artifactId, input.agentId, wantedAgentAccess(input));

  const email = input.email!;
  // The request schema requires a role for a person (null removes).
  const role = input.role;
  if (role === undefined) throw errors.invalid("Give a role ('editor', 'viewer' or null)", { field: 'role' });
  const uid = await uidForEmail(email);
  if (role === null) return removePerson(ctx, artifactId, email, uid);
  if (uid) return grantPerson(ctx, artifactId, email, uid, role);
  return invitePerson(ctx, artifactId, email, role);
});
