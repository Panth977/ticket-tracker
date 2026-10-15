/**
 * Envs (shared/src/env): who may read or write the pairs of which thing, and
 * what a thing's effective env is. One doc per thing at _env/{kind}:{id},
 * server-only, so the permission here is the only way in.
 */
import { envDocPath, errors, isAgentId, paths, type EnvKind, type EnvVars } from '@tm/shared';
import { roleOf } from '@tm/shared/logic/index';
import { artifactRef, roleFor } from '../artifacts/shared.js';
import { bucketRef, reachFor } from '../bucket/shared.js';
import { db } from '../db/index.js';
import { requestBoard } from '../platform/resolve.js';
import type { ServerCtx } from '../runtime/context.js';

export interface EnvDoc {
  vars: EnvVars;
  updatedAt: number;
  updatedBy: string;
}

/** The thing, resolved (a board KEY becomes its id), once the caller may do `op` on its env. */
export async function envTarget(
  ctx: ServerCtx,
  kind: EnvKind,
  id: string,
  op: 'read' | 'write',
): Promise<{ id: string; orgId: string | null }> {
  const agent = isAgentId(ctx.actor);
  if (op === 'write' && agent) throw errors.forbidden('Agents cannot change envs');
  const deny = () => {
    throw errors.forbidden(
      op === 'read' ? 'You cannot see this env' : 'You cannot change this env',
    );
  };
  switch (kind) {
    case 'board': {
      const b = await requestBoard(ctx, id).catch(() => {
        throw errors.not_found('No such board');
      });
      const role = roleOf(b, ctx.actor);
      const ok =
        op === 'write'
          ? role === 'admin'
          : role === 'admin' || role === 'editor' || (agent && !!role);
      if (!ok) deny();
      return { id: b.id, orgId: ownerOrg(b) };
    }
    case 'artifact': {
      const a = (await artifactRef(id).get()).data();
      if (!a) throw errors.not_found('No such artifact');
      const role = roleFor(ctx, a);
      const ok = op === 'write' ? role === 'owner' : role === 'owner' || role === 'editor';
      if (!ok) deny();
      return { id, orgId: ownerOrg(a) };
    }
    case 'bucket': {
      const m = (await bucketRef(id).get()).data();
      if (!m) throw errors.not_found('No such bucket');
      const reach = await reachFor(ctx, m);
      const ok = op === 'write' ? reach === 'manage' : reach === 'manage' || reach === 'write';
      if (!ok) deny();
      return { id, orgId: ownerOrg(m) };
    }
    case 'agent': {
      const g = (await db().doc(paths.agent(id)).get()).data() as { ownerUid?: string } | undefined;
      if (!g) throw errors.not_found('No such agent');
      const ok =
        op === 'write' ? g.ownerUid === ctx.actor : g.ownerUid === ctx.actor || ctx.actor === id;
      if (!ok) deny();
      return { id, orgId: null };
    }
    case 'org':
      return orgTarget(ctx, id, op);
  }
}

/** The org a thing belongs to (owners/orgs, §AC), or null. */
function ownerOrg(thing: unknown): string | null {
  const o = (thing as { owner?: { kind?: string; id?: string } }).owner;
  return o?.kind === 'org' && o.id ? o.id : null;
}

/** Set by the orgs module when it loads (§AC); until then there are no orgs. */
let orgTarget: (
  ctx: ServerCtx,
  id: string,
  op: 'read' | 'write',
) => Promise<{ id: string; orgId: string | null }> = async () => {
  throw errors.not_found('No such org');
};
export function provideOrgEnvTarget(fn: typeof orgTarget): void {
  orgTarget = fn;
}

export async function readEnv(kind: EnvKind, id: string): Promise<EnvDoc | null> {
  const snap = await db().doc(envDocPath(kind, id)).get();
  return snap.exists ? (snap.data() as EnvDoc) : null;
}

/** Own, inherited (the org's) and effective pairs of a resolved thing. */
export async function envOf(
  kind: EnvKind,
  t: { id: string; orgId: string | null },
): Promise<{ vars: EnvVars; inherited: EnvVars; effective: EnvVars; updatedAt: number | null }> {
  const [own, org] = await Promise.all([
    readEnv(kind, t.id),
    t.orgId && kind !== 'org' ? readEnv('org', t.orgId) : Promise.resolve(null),
  ]);
  const vars = own?.vars ?? {};
  const inherited = org?.vars ?? {};
  return {
    vars,
    inherited,
    effective: { ...inherited, ...vars },
    updatedAt: own?.updatedAt ?? null,
  };
}

/** Removing a thing removes its env (best effort; it holds nothing without the thing). */
export async function dropEnv(kind: EnvKind, id: string): Promise<void> {
  await db()
    .doc(envDocPath(kind, id))
    .delete()
    .catch(() => {});
}
