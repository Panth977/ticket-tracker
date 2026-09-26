/**
 * intakeUpsert (extra command; Board settings › Intake). intakes/{slug} is
 * server-only, so the settings screen reads and writes it here.
 *
 *   can(admin) on the board
 *   no other key than boardId → just read (intake: null when there is none)
 *   first write creates it: slug '{boardkey}-{6 chars}', a secret shown ONCE
 *   rotateSecret → a new secret shown once; the old one stops working at once
 *
 * Registered from here (imported by doors/rest.ts) because the platform step
 * owns backend/src/platform/**, not an intake* file under commands/.
 */
import { COLLECTIONS, DEFAULT_INTAKE_LIMITS, errors, paths, type Intake } from '@tm/shared';
import { defineCommand } from '../commands/_registry.js';
import { inboundDomain } from '../notify/config.js';
import { db } from '../runtime/firebase.js';
import { loadBoard, requireCan } from '../tickets/access.js';
import { base62, sha256hex } from './crypto.js';

export default defineCommand('intakeUpsert', async (ctx, input) => {
  const board = await loadBoard(ctx, input.boardId);
  requireCan(ctx, board, 'admin', null, null, 'Only board admins manage intake');

  const existing = await db()
    .collection(COLLECTIONS.intakes)
    .where('boardId', '==', board.id)
    .limit(1)
    .get();
  const hit = existing.docs[0];
  const { boardId: _b, clientId: _c, ...changes } = input;
  const wantsWrite = Object.values(changes).some((v) => v !== undefined);
  if (!hit && !wantsWrite) return { intake: null };

  for (const f of Object.values(input.fieldMap ?? {}))
    if (!board.fields.some((d) => d.id === f && !d.archived))
      throw errors.invalid(`fieldMap names an unknown field "${f}"`, { field: 'fieldMap' });
  const d = input.defaults;
  if (d?.stageId && !board.stages.some((s) => s.id === d.stageId))
    throw errors.invalid('Unknown default stage', { field: 'defaults.stageId' });
  if (d?.priorityId && !board.priorities.some((p) => p.id === d.priorityId))
    throw errors.invalid('Unknown default priority', { field: 'defaults.priorityId' });
  if (d?.tagIds?.some((t) => !board.tags.some((x) => x.id === t)))
    throw errors.invalid('Unknown default tag', { field: 'defaults.tagIds' });
  if (d?.assigneeUids?.some((u) => !board.access[u]))
    throw errors.invalid('Default assignees must be on the board', {
      field: 'defaults.assigneeUids',
    });

  const slug = hit?.id ?? `${board.key.toLowerCase()}-${base62(6).toLowerCase()}`;
  const cur = hit?.data() as Intake | undefined;
  const rotate = !cur || input.rotateSecret === true;
  const secret = rotate ? `tmi_${base62(32)}` : undefined;
  if (!wantsWrite && cur) {
    const { secretHash: _s, ...pub } = cur;
    return { intake: { ...pub, slug } };
  }
  const next: Intake = {
    boardId: board.id,
    enabled: input.enabled ?? cur?.enabled ?? true,
    secretHash: secret ? sha256hex(secret) : cur!.secretHash,
    rotatedAt: secret ? ctx.now : cur!.rotatedAt,
    limits: cur?.limits ?? { ...DEFAULT_INTAKE_LIMITS },
    allowedOrigins: input.allowedOrigins ?? cur?.allowedOrigins ?? [],
    defaults: input.defaults ?? cur?.defaults ?? {},
    fieldMap: input.fieldMap ?? cur?.fieldMap ?? {},
    email: cur?.email ?? `${slug}@${inboundDomain()}`,
  };
  await db().doc(paths.intake(slug)).set(next);
  const { secretHash: _s, ...pub } = next;
  return { intake: { ...pub, slug }, ...(secret ? { secret } : {}) };
});
