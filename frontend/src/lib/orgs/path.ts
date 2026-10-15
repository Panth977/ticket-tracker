/**
 * What an app URL names (agents.html §AC): the old /b/{KEY}, /x/{id},
 * /bucket/{id} and the owner-first /{handle}/b/{KEY}, /{handle}/x/{slug},
 * /{handle}/bucket/{slug}. `ref` is a KEY, an id or a slug.
 */
import { RESERVED_HANDLES } from '@tm/shared';

export interface ThingPath {
  kind: 'board' | 'artifact' | 'bucket';
  ref: string;
  handle: string | null;
  /** Whatever follows (/settings/people, /{viewId} …), with a leading '/', or ''. */
  rest: string;
}

const KIND = { b: 'board', x: 'artifact', bucket: 'bucket' } as const;

export function parseThingPath(pathname: string): ThingPath | null {
  const segs = pathname.split('/').filter(Boolean);
  const at = (i: number) => segs[i] ?? '';
  if (at(0) in KIND && at(1)) {
    return {
      kind: KIND[at(0) as keyof typeof KIND],
      ref: decodeURIComponent(at(1)),
      handle: null,
      rest: tail(segs, 2),
    };
  }
  if (at(0) && !RESERVED_HANDLES.has(at(0)) && at(1) in KIND && at(2)) {
    return {
      kind: KIND[at(1) as keyof typeof KIND],
      ref: decodeURIComponent(at(2)),
      handle: decodeURIComponent(at(0)),
      rest: tail(segs, 3),
    };
  }
  return null;
}

/** /{handle} or /{handle}/settings/… — an owner page (null for app routes). */
export function parseOwnerPath(pathname: string): { handle: string; rest: string } | null {
  const segs = pathname.split('/').filter(Boolean);
  if (!segs[0] || RESERVED_HANDLES.has(segs[0]) || (segs[1] && segs[1] in KIND)) return null;
  return { handle: decodeURIComponent(segs[0]), rest: tail(segs, 1) };
}

const tail = (segs: string[], from: number) =>
  segs.length > from ? '/' + segs.slice(from).join('/') : '';
