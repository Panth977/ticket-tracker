/**
 * Optimistic overlays. command(…, { optimistic }) layers a patch over a
 * document path; every live store showing that path renders base ⊕ patch
 * until the command settles, then the overlay is removed (on success the
 * server snapshot already carries the change; on failure it rolls back).
 *
 * A patch is a shallow merge whose keys may be dotted ('fields.abc'); a
 * patch of `null` hides the document (e.g. archived out of an active list).
 */
export type Patch = Record<string, unknown> | null;

type Listener = () => void;

const layers = new Map<string, { token: number; patch: Patch }[]>();
const listeners = new Set<Listener>();
let nextToken = 1;

export function onOverlayChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const l of [...listeners]) l();
}

/** Apply `patch` over the document at `path`; returns the rollback. */
export function patchDoc(path: string, patch: Patch): () => void {
  const token = nextToken++;
  const list = layers.get(path) ?? [];
  list.push({ token, patch });
  layers.set(path, list);
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const l = layers.get(path);
    if (!l) return;
    const rest = l.filter((x) => x.token !== token);
    if (rest.length) layers.set(path, rest);
    else layers.delete(path);
    emit();
  };
}

export function hasOverlay(path: string): boolean {
  return layers.has(path);
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const next = cur[p];
    const copy =
      next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as object) } : {};
    cur[p] = copy;
    cur = copy as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** base ⊕ overlays(path). `undefined` = hidden by a null patch. */
export function applyOverlays<T extends object>(path: string, base: T): T | undefined {
  const l = layers.get(path);
  if (!l) return base;
  let out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const { patch } of l) {
    if (patch === null) return undefined;
    out = { ...out };
    for (const [k, v] of Object.entries(patch)) setDotted(out, k, v);
  }
  return out as T;
}

/** Test helper. */
export function _resetOverlays() {
  layers.clear();
  emit();
}
