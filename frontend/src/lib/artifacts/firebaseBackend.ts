/**
 * The broker's stores, for real: the Firebase Web SDK as the signed-in viewer
 * (docs/plan/artifacts.html §E3). Deliberately dumb — every path arrives
 * already built by the broker through the fence, every value already checked
 * and converted — so there is nothing here for an artifact to talk into
 * misbehaving. The rules decide what each call may do (§E4).
 *
 * Storage: uploads go straight to the bucket (a write rule checks the role);
 * reading a URL, listing and deleting go through commands, because Storage
 * rules cannot be relied on to look the role up in Firestore (storage.rules).
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit as qLimit,
  onSnapshot,
  orderBy as qOrderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter as qStartAfter,
  Timestamp,
  updateDoc,
  where as qWhere,
  type Query,
  type QueryConstraint,
} from 'firebase/firestore';
import {
  get as rGet,
  onValue,
  push as rPush,
  ref as rRef,
  remove as rRemove,
  serverTimestamp as rServerTimestamp,
  set as rSet,
  update as rUpdate,
} from 'firebase/database';
import { ref as sRef, uploadBytes } from 'firebase/storage';
import { paths, type BoardMember, type BoardWithId, type TicketWithId } from '@tm/shared';
import { command } from '$lib/api';
import { getDb, getRtdb, getStorageClient } from '$lib/firebase/client';
import { BrokerError, type BrokerBackend, type CheckedQuery, type StoredRow } from './broker';
import { ValueError } from './convert';

/** RTDB keys: no . $ # [ ] / or control characters (and so no '.sv' / '.priority' smuggled in a value). */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const RTDB_BAD_KEY = /[.$#[\]/\u0000-\u001f\u007f]/;

async function buildQuery(path: string, q: CheckedQuery): Promise<Query> {
  const db = getDb();
  const col = collection(db, path);
  const parts: QueryConstraint[] = q.where.map(([f, op, v]) => qWhere(f, op, v));
  if (q.orderBy) parts.push(qOrderBy(q.orderBy[0], q.orderBy[1]));
  if (q.startAfter) {
    if (q.orderBy) {
      // A cursor in a field order needs that document's field value: read it.
      const snap = await getDoc(doc(db, `${path}/${q.startAfter}`));
      if (!snap.exists())
        throw new BrokerError(
          'not-found',
          `startAfter: no document '${q.startAfter}' in this collection`,
        );
      parts.push(qStartAfter(snap));
    } else {
      // No order given = by id, and then the id itself is the cursor (no read).
      parts.push(qOrderBy(documentId()), qStartAfter(q.startAfter));
    }
  }
  parts.push(qLimit(q.limit));
  return query(col, ...parts);
}

const rows = (snap: { docs: { id: string; data(): Record<string, unknown> }[] }): StoredRow[] =>
  snap.docs.map((d) => ({ id: d.id, data: d.data() }));

/** `artifactId` is only for the three file commands — the host page's id, never the iframe's. */
export function firebaseBackend(artifactId: string): BrokerBackend {
  return {
    fs: {
      codec: { date: (d) => Timestamp.fromDate(d), serverTime: () => serverTimestamp() },
      asDate: (v) => (v instanceof Timestamp ? v.toDate() : null),
      async get(path) {
        const snap = await getDoc(doc(getDb(), path));
        return { exists: snap.exists(), data: snap.exists() ? snap.data() : null };
      },
      set: (path, data, merge) => setDoc(doc(getDb(), path), data, merge ? { merge: true } : {}),
      update: (path, patch) => updateDoc(doc(getDb(), path), patch),
      delete: (path) => deleteDoc(doc(getDb(), path)),
      add: async (path, data) => (await addDoc(collection(getDb(), path), data)).id,
      list: async (path, q) => rows(await getDocs(await buildQuery(path, q))),
      onDoc: (path, next, error) =>
        onSnapshot(
          doc(getDb(), path),
          (snap) => next({ exists: snap.exists(), data: snap.exists() ? snap.data() : null }),
          error,
        ),
      onList(path, q, next, error) {
        // buildQuery may have to read the cursor document first; honour a stop
        // that arrives before the listener exists.
        let off: (() => void) | null = null;
        let stopped = false;
        buildQuery(path, q).then((built) => {
          if (!stopped) off = onSnapshot(built, (snap) => next(rows(snap)), error);
        }, error);
        return () => {
          stopped = true;
          off?.();
        };
      },
    },
    rtdb: {
      codec: {
        // RTDB has no timestamp type: a Date is stored as its milliseconds.
        date: (d) => d.getTime(),
        serverTime: () => rServerTimestamp(),
        key: (k) => {
          if (!k || RTDB_BAD_KEY.test(k))
            throw new ValueError(`'${k}' is not a valid Realtime Database key`);
        },
        finiteOnly: true,
      },
      get: async (path) => (await rGet(rRef(getRtdb(), path))).val(),
      set: (path, value) => rSet(rRef(getRtdb(), path), value),
      update: (path, patch) => rUpdate(rRef(getRtdb(), path), patch),
      async push(path, value) {
        const child = rPush(rRef(getRtdb(), path));
        await rSet(child, value);
        return child.key!;
      },
      remove: (path) => rRemove(rRef(getRtdb(), path)),
      on: (path, next, error) => onValue(rRef(getRtdb(), path), (snap) => next(snap.val()), error),
    },
    storage: {
      async upload(path, blob, contentType) {
        await uploadBytes(sRef(getStorageClient(), path), blob, { contentType });
      },
    },
    files: {
      // toast: false — these are the ARTIFACT's calls; their failures are its to
      // show, as a rejected Promise, not a toast over somebody's dashboard.
      url: (path) => command('artifactFileUrl', { artifactId, path }, { toast: false }),
      list: async (path) =>
        (await command('artifactFileList', { artifactId, path }, { toast: false })).files,
      async delete(path) {
        await command('artifactFileDelete', { artifactId, path }, { toast: false });
      },
    },
    // §K: reads in the viewer's session (rules: boards they are on), writes as
    // the ticket commands in their name — the broker has already checked the grant.
    tickets: {
      async board(boardId) {
        try {
          const snap = await getDoc(doc(getDb(), paths.board(boardId)));
          return snap.exists() ? ({ ...snap.data(), id: boardId } as BoardWithId) : null;
        } catch {
          return null; // not on that board: for the artifact, it is not there
        }
      },
      members: async (boardId) =>
        (await getDocs(collection(getDb(), paths.members(boardId)))).docs.map(
          (d) => ({ ...d.data(), uid: d.id }) as BoardMember,
        ),
      list: async (boardId, state, stageId) =>
        ticketRows(boardId, await getDocs(ticketQuery(boardId, state, stageId))),
      onList: (boardId, state, stageId, next, error) =>
        onSnapshot(
          ticketQuery(boardId, state, stageId),
          (snap) => next(ticketRows(boardId, snap)),
          error,
        ),
      async byKey(boardId, key) {
        const snap = await getDocs(
          query(collection(getDb(), paths.tickets(boardId)), qWhere('key', '==', key), qLimit(1)),
        );
        return ticketRows(boardId, snap)[0] ?? null;
      },
      // Field values are whatever the artifact sent: ticketCreate's own schema checks them
      // before the request leaves (command() validates), so an odd one is an invalid-argument.
      create: (input) =>
        command('ticketCreate', input as Parameters<typeof command<'ticketCreate'>>[1], {
          toast: false,
        }),
      async update(boardId, ticketId, patch) {
        await command(
          'ticketUpdate',
          { boardId, ticketId, patch: patch as never },
          { toast: false },
        );
      },
      async comment(boardId, ticketId, body, markdown) {
        await command('messagePost', { boardId, ticketId, body, markdown }, { toast: false });
      },
    },
  };
}

function ticketQuery(boardId: string, state: string, stageId: string | null): Query {
  const parts: QueryConstraint[] = [qWhere('state', '==', state)];
  if (stageId) parts.push(qWhere('stageId', '==', stageId));
  return query(collection(getDb(), paths.tickets(boardId)), ...parts);
}

const ticketRows = (
  boardId: string,
  snap: { docs: { id: string; data(): Record<string, unknown> }[] },
): TicketWithId[] => snap.docs.map((d) => ({ ...d.data(), id: d.id, boardId }) as TicketWithId);
