/**
 * IMPORT FROM DRIVE (docs/plan/bucket.html §L7) — a folder another (or this)
 * TaskManager kept an entity in becomes an entity here again, pointing at
 * the same folder. Nothing is copied: the folder stays the truth.
 *
 *   .tm-entity.json   what it is (kind, id, name, a board's key) and its people by e-mail
 *   .tm-keys.json     its data key; sealed for another instance → the recovery code re-seals it here
 *
 * The importer becomes its owner (a board's admin); the manifest's other people
 * come back as a list to invite — an e-mail is not an account here. Ids are the
 * original ones (a board's tickets carry its id in their appProperties), so a
 * folder already imported here is refused. A board's key must be free.
 */
import {
  DEFAULT_ATTACH_TEMPLATE,
  errors,
  isAgentId,
  paths,
  type Board,
  type BoardDriveStorage,
  type BoardPref,
} from '@tm/shared';
import { isFolder } from '../../bucket/drive/api.js';
import { driveEmail, driveFor } from '../../bucket/drive/link.js';
import type { ServerCtx } from '../../runtime/context.js';
import { baseDb, db, Timestamp } from '../index.js';
import {
  forgetDriveBoardIds,
  forgetEntityStorage,
  type DriveEntity,
  type EntityKind,
} from './board.js';
import { readDocFile } from './docfiles.js';
import { ENTITY_SPECS } from './entities.js';
import { listTickets, TICKETS, type DriveBoard } from './files.js';
import { dataKeyOf, decodeCode, sealerFor } from './keyring.js';
import { MANIFEST_FILE, MANIFEST_SCHEMA, type Manifest } from './manifest.js';
import { decodeJson } from './values.js';

type Json = Record<string, unknown>;

export interface Imported {
  kind: EntityKind;
  id: string;
  name: string;
  /** The manifest's other people: invite them (an e-mail is not an account here). */
  people: { email: string; role: string }[];
  /** A board's file bucket, imported with it. */
  bucketId?: string;
  key?: string;
}

const KIND_SINGULAR: Record<EntityKind, 'board' | 'dictionary' | 'bucket' | 'artifact'> = {
  boards: 'board',
  dictionaries: 'dictionary',
  buckets: 'bucket',
  artifacts: 'artifact',
};

export async function importFromDrive(
  ctx: ServerCtx,
  input: { folderId: string; recoveryCode?: string | undefined },
): Promise<Imported> {
  if (isAgentId(ctx.actor) || ctx.keyId || ctx.via !== 'app')
    throw errors.forbidden('Import from Google Drive in the app (Account › Google Drive)');
  const api = await driveFor(ctx.actor);
  const folder = await api.get(input.folderId);
  if (!folder || folder.trashed || !isFolder(folder))
    throw errors.invalid('Pick a folder of your Google Drive', { field: 'folderId' });
  const { doc } = await readDocFile(api, folder.id, [MANIFEST_FILE], null);
  const m = doc as Manifest | undefined;
  if (!m || m.schema !== MANIFEST_SCHEMA || !(m.kind in ENTITY_SPECS) || !m.id)
    throw errors.invalid(
      'That folder holds no TaskManager board, dictionary, bucket or artifact (no .tm-entity.json)',
      { field: 'folderId' },
    );
  const kind = m.kind as EntityKind;
  const ref = baseDb().doc(`${kind}/${m.id}`);
  if ((await ref.get()).exists)
    throw errors.conflict(`This ${KIND_SINGULAR[kind]} is already in this TaskManager`);

  const e: DriveEntity = { kind, id: m.id, uid: ctx.actor, folderId: folder.id };
  // Its secrets: opened (and, from another instance, re-sealed for this one) before anything is made.
  const { doc: keys } = await readDocFile(api, folder.id, ['.tm-keys'], null);
  if (keys) await dataKeyOf(e, input.recoveryCode ? decodeCode(input.recoveryCode) : undefined);

  const storage: BoardDriveStorage = {
    kind: 'drive',
    uid: ctx.actor,
    folderId: folder.id,
    folderName: folder.name,
    email: await driveEmail(ctx.actor),
  };
  const { ownerForCreate, freeSlug, syncThing } = await import('../../org/shared.js');
  const own = await ownerForCreate(ctx.actor, undefined);
  const people = m.people.filter((p) => p.role !== 'owner' || m.owner !== p.email);
  const base = {
    name: m.name,
    description: m.description ?? null,
    ...(m.indicator ? { indicator: m.indicator } : {}),
    archivedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  forgetEntityStorage(kind, m.id);

  if (kind === 'boards') return importBoard(ctx, m, e, storage, own.fields, people);

  const slug = await freeSlug(KIND_SINGULAR[kind] as 'dictionary', own.fields.owner, m.name);
  if (kind === 'dictionaries') {
    const content = (await readDocFile(api, folder.id, ['content', 'entries'], await sealerFor(e)))
      .doc as { entries?: { k: string; v: string }[] } | undefined;
    const entries = content?.entries ?? [];
    await db()
      .doc(paths.dictionary(m.id))
      .create({
        ...base,
        ownerUid: ctx.actor,
        ...own.fields,
        slug,
        access: { [ctx.actor]: 'owner' },
        memberUids: [ctx.actor],
        boards: {},
        artifacts: {},
        agents: {},
        boardIds: [],
        artifactIds: [],
        agentIds: [],
        stats: { entries: entries.length, bytes: Buffer.byteLength(JSON.stringify(entries)) },
        storage,
      });
  } else if (kind === 'artifacts') {
    await db()
      .doc(`artifacts/${m.id}`)
      .create({
        ...base,
        ownerUid: ctx.actor,
        ...own.fields,
        slug,
        access: { [ctx.actor]: 'owner' },
        memberUids: [ctx.actor],
        agents: {},
        boards: {},
        readOnly: false,
        currentBuild: null,
        storage,
      });
    const { syncArtifactMirror } = await import('../../artifacts/shared.js');
    const made = (await baseDb().doc(`artifacts/${m.id}`).get()).data();
    if (made) await syncArtifactMirror(m.id, made as never);
  } else {
    await db()
      .doc(paths.bucket(m.id))
      .create({
        ...base,
        ownerUid: ctx.actor,
        ...own.fields,
        slug,
        access: { [ctx.actor]: 'owner' },
        memberUids: [ctx.actor],
        boards: {},
        artifacts: {},
        boardIds: [],
        storage: {
          kind: 'drive',
          uid: ctx.actor,
          folderId: folder.id,
          folderName: folder.name,
          email: storage.email,
        },
        stats: { files: 0, folders: 0, bytes: 0 },
      });
  }
  if (own.org) await syncThing(KIND_SINGULAR[kind] as 'bucket', m.id, own.org);
  return { kind, id: m.id, name: m.name, people };
}

async function importBoard(
  ctx: ServerCtx,
  m: Manifest,
  e: DriveEntity,
  storage: BoardDriveStorage,
  ownerFields: Record<string, unknown>,
  people: Imported['people'],
): Promise<Imported> {
  const api = await driveFor(ctx.actor);
  const key = m.key;
  if (!key) throw errors.invalid('That board folder names no key', { field: 'folderId' });
  if ((await baseDb().doc(paths.boardKey(key)).get()).exists)
    throw errors.conflict(`The key ${key} is taken here — a board with it exists`, { key });
  const kids = await api.children([e.folderId]);
  const ticketsFolderId = kids.find((k) => isFolder(k) && k.name === TICKETS)?.id ?? null;
  storage.ticketsFolderId = ticketsFolderId;
  const settings = decodeJson(
    (await readDocFile(api, e.folderId, [ENTITY_SPECS.boards.settingsFile], null)).doc ?? {},
    Timestamp,
  ) as Json;
  const b: DriveBoard = { boardId: m.id, uid: ctx.actor, folderId: e.folderId, ticketsFolderId };
  const tickets = await listTickets(api, b);
  let maxNumber = 0;
  const counts = { active: 0, done: 0, overdue: 0 };
  for (const t of tickets) {
    const n = Number(t.doc.number ?? 0);
    if (n > maxNumber) maxNumber = n;
    if (t.doc.state === 'active') {
      if (t.doc.stageCategory === 'done') counts.done++;
      else counts.active++;
    }
  }

  const { deriveAccess, memberDoc, profileOf, syncReaders } =
    await import('../../commands/boardShared.js');
  const access = { [ctx.actor]: 'admin' as const };
  const board = {
    name: m.name,
    key,
    nextNumber: maxNumber + 1,
    color: (m.indicator as { color?: string } | null)?.color ?? '#5b6b7f',
    icon: '',
    ...(m.indicator ? { indicator: m.indicator } : {}),
    description: m.description ?? null,
    access,
    stageGrants: {},
    ...deriveAccess(access),
    ...settings,
    counts,
    archivedAt: null,
    createdBy: ctx.actor,
    createdAt: ctx.now,
    ...ownerFields,
    storage,
  } as unknown as Board;
  const profile = await profileOf(ctx.actor);
  const pref: BoardPref = {
    mode: 'mine',
    watching: [],
    starred: false,
    lastViewId: String((settings.defaultViewId as string | undefined) ?? 'board'),
  };
  await db().runTransaction(async (tx) => {
    const keyRef = db().doc(paths.boardKey(key));
    if ((await tx.get(keyRef)).exists) throw errors.conflict(`The key ${key} is taken`, { key });
    tx.create(keyRef, { boardId: m.id, claimedAt: ctx.now });
    tx.create(db().doc(paths.board(m.id)), board as never);
    tx.create(
      db().doc(paths.member(m.id, ctx.actor)),
      memberDoc(ctx.actor, 'admin', profile, null, ctx.now),
    );
    tx.set(db().doc(paths.pref(m.id, ctx.actor)), pref);
  });
  // The ticket keys: '#KEY-42' finds its ticket here again.
  for (let i = 0; i < tickets.length; i += 400) {
    const batch = baseDb().batch();
    for (const t of tickets.slice(i, i + 400))
      if (typeof t.doc.key === 'string')
        batch.set(baseDb().doc(paths.key(t.doc.key)), {
          ticketId: t.id,
          boardId: m.id,
          current: t.doc.key,
          deleted: false,
        });
    await batch.commit();
  }
  await syncReaders(m.id, [ctx.actor]);
  forgetDriveBoardIds();

  // Its file bucket, when the folder has one.
  let bucketId: string | undefined;
  const files = kids.find((k) => isFolder(k) && k.name === 'files');
  if (files) {
    const { doc: fm } = await readDocFile(api, files.id, [MANIFEST_FILE], null);
    try {
      const imported = fm ? await importFromDrive(ctx, { folderId: files.id }) : null;
      bucketId = imported?.id;
    } catch (err) {
      console.warn('[drive] board import: its file bucket was not imported', err);
    }
    if (bucketId) {
      await baseDb()
        .doc(paths.bucket(bucketId))
        .update({ [`boards.${m.id}`]: 'write', boardIds: [m.id] });
      await db()
        .doc(paths.board(m.id))
        .update({ attachBucket: { bucketId, template: DEFAULT_ATTACH_TEMPLATE } });
    }
  }
  return {
    kind: 'boards',
    id: m.id,
    name: m.name,
    key,
    people,
    ...(bucketId ? { bucketId } : {}),
  };
}
