/**
 * What a backend artifact may do: the host API its code reaches through the gateway.
 *
 * It acts as the artifact's OWNER, through the owner's real rights, and the board
 * grants are a ceiling on top, the same two locks the page's broker has (§K). Owner
 * loses a board, or the grant goes: the call fails. Data calls go through the same
 * fence as every other door (platform/artifactData.ts).
 */
import { errors, type Artifact, type ArtifactBoardAccess } from '@tm/shared';
import { dataDelete, dataGet, dataList, dataSet } from '../platform/artifactData.js';
import { createTicket, listTickets, postComment } from '../platform/ops.js';
import { requestBoard, ticketByKey } from '../platform/resolve.js';
import { makeCtx, type ServerCtx } from '../runtime/context.js';
import { artifactRef } from './shared.js';

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v) throw errors.invalid(`${name} is required`);
  return v;
};

function grant(artifact: Artifact, boardId: string, need: ArtifactBoardAccess): void {
  const have = artifact.boards?.[boardId];
  if (!have || (need === 'write' && have !== 'write'))
    throw errors.forbidden('This artifact has no such grant on that board');
}

const view = (t: { key: string; title: string; stageId?: string; state?: string }) => ({
  key: t.key,
  title: t.title,
  stage: t.stageId ?? '',
  state: t.state ?? '',
});

type Input = Record<string, unknown>;

async function board(ctx: ServerCtx, artifact: Artifact, key: unknown, need: ArtifactBoardAccess) {
  const b = await requestBoard(ctx, str(key, 'board'));
  grant(artifact, b.id, need);
  return b;
}

const OPS: Record<string, (ctx: ServerCtx, a: Artifact, id: string, i: Input) => Promise<unknown>> = {
  'tickets.get': async (ctx, a, _id, i) => {
    const { board: b, ticket } = await ticketByKey(ctx, str(i.key, 'key'));
    grant(a, b.id, 'read');
    return view(ticket as never);
  },
  'tickets.list': async (ctx, a, _id, i) => {
    const b = await board(ctx, a, i.board, 'read');
    const page = await listTickets(ctx, b, { limit: Math.min(Number(i.limit ?? 50), 200) } as never);
    return page.data.map((t) => view(t as never));
  },
  'tickets.create': async (ctx, a, _id, i) => {
    const b = await board(ctx, a, i.board, 'write');
    const t = await createTicket(ctx, b, {
      title: str(i.title, 'title'),
      ...(typeof i.markdown === 'string' ? { description_md: i.markdown } : {}),
    });
    return view(t as never);
  },
  'tickets.comment': async (ctx, a, _id, i) => {
    const { board: b, ticket } = await ticketByKey(ctx, str(i.key, 'key'));
    grant(a, b.id, 'write');
    await postComment(ctx, b, ticket, str(i.markdown, 'markdown'), undefined);
    return null;
  },
  'db.get': async (ctx, _a, id, i) => (await dataGet(ctx, id, i.path)) as unknown,
  'db.list': async (ctx, _a, id, i) => {
    const page = await dataList(ctx, id, i.path, { limit: Math.min(Number(i.limit ?? 100), 500) } as never);
    return page.data;
  },
  'db.set': async (ctx, _a, id, i) => {
    await dataSet(ctx, id, i.path, i.value, i.merge === true);
    return null;
  },
  'db.delete': async (ctx, _a, id, i) => {
    await dataDelete(ctx, id, i.path);
    return null;
  },
};

export async function runHostOp(artifactId: string, op: string, input: Input): Promise<unknown> {
  const fn = OPS[op];
  if (!fn) throw errors.not_found(`No host API ${op}`);
  const snap = await artifactRef(artifactId).get();
  const artifact = snap.data() as Artifact | undefined;
  if (!artifact || artifact.deletingAt || !artifact.backend) throw errors.not_found('No such backend');
  const ctx = makeCtx({ actor: artifact.ownerUid, via: 'integration' });
  return fn(ctx, artifact, artifactId, input);
}
