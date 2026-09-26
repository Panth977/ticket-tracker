/**
 * A live collection-group ticket query that keeps each row's boardId (taken
 * from the document path boards/{boardId}/tickets/{ticketId}) — the shared
 * queryStore only carries `id`, and My work needs the board to link, label
 * and call ticketUpdate. Shared + ref-counted through the same registry, and
 * optimistic overlays apply by path exactly as in queryStore.
 */
import { collectionGroup, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { readable, type Readable } from 'svelte/store';
import { parseTicketPath, type Ticket } from '@tm/shared';
import { getDb } from '$lib/firebase/client';
import { registry, specKey, type QuerySpec, type QueryState } from '$lib/stores/live';
import { applyOverlays, onOverlayChange } from '$lib/stores/overlay';
import type { MyTicket } from './myWork';

const IDLE: QueryState<MyTicket> = { loading: false, error: null, data: [], fromCache: false };

export function groupTickets(
  spec: QuerySpec | null,
): Readable<QueryState<Ticket & { boardId: string }>> {
  if (!spec) return readable(IDLE);
  return registry.get<QueryState<MyTicket>>(
    'g:' + specKey(spec),
    { loading: true, error: null, data: [], fromCache: false },
    (set) => {
      let rows: { path: string; data: MyTicket }[] = [];
      let meta = { loading: true, error: null as Error | null, fromCache: false };
      const render = () => {
        const data: MyTicket[] = [];
        for (const r of rows) {
          const v = applyOverlays(r.path, r.data);
          if (v) data.push(v);
        }
        set({ ...meta, data });
      };
      const offOverlay = onOverlayChange(render);
      let offSnap = () => {};
      try {
        const q = query(
          collectionGroup(getDb(), spec.path),
          ...(spec.where ?? []).map(([f, op, v]) => where(f, op, v)),
          ...(spec.orderBy ?? []).map(([f, d]) => orderBy(f, d ?? 'asc')),
          ...(spec.limit ? [limit(spec.limit)] : []),
        );
        offSnap = onSnapshot(
          q,
          (snap) => {
            rows = snap.docs.flatMap((d) => {
              const ids = parseTicketPath(d.ref.path);
              return ids
                ? [
                    {
                      path: d.ref.path,
                      data: { ...(d.data() as Ticket), id: d.id, boardId: ids.boardId },
                    },
                  ]
                : [];
            });
            meta = { loading: false, error: null, fromCache: snap.metadata.fromCache };
            render();
          },
          (err) => {
            rows = [];
            meta = { loading: false, error: err, fromCache: false };
            render();
          },
        );
      } catch (e) {
        meta = {
          loading: false,
          error: e instanceof Error ? e : new Error(String(e)),
          fromCache: false,
        };
        render();
      }
      return () => {
        offSnap();
        offOverlay();
      };
    },
  );
}
