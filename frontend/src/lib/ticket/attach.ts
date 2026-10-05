/**
 * TICKET ATTACHMENTS GO INTO A MEMORY (docs/plan/memory.html §J). The pure
 * half of the attach dialog and of board settings › Memory › Ticket
 * attachments: which memories a file may go into, the path each file is
 * offered, what is wrong with a typed path, and what messagePost is sent.
 *
 * Paths are SHOWN with a leading '/', as everywhere in the Memory app; the
 * commands take them without it.
 */
import {
  attachFileName,
  attachTemplateProblem,
  DEFAULT_ATTACH_TEMPLATE,
  fillAttachTemplate,
  normalizeMemoryPath,
  type BoardAttachMemory,
  type MemoryGrant,
  type MemoryOut,
  type MemoryUpload,
} from '@tm/shared';

/**
 * memoryList({ boardId }) answers the memories granted to the board. When the
 * server says what the grant IS (`boardGrant`), that decides; until then the
 * caller's own reach stands in for it — write reach on a memory granted to the
 * board, or the board's attachment default (the server clears that default
 * when the memory's write grant goes, so it is always write-granted).
 */
export type BoardMemoryOut = Omit<MemoryOut, 'boardGrant'> & { boardGrant?: MemoryGrant | null };

export function isWriteGranted(
  m: BoardMemoryOut,
  attachMemory: BoardAttachMemory | null | undefined,
): boolean {
  if (m.archived) return false;
  if (m.boardGrant !== undefined) return m.boardGrant === 'write';
  return m.id === attachMemory?.memoryId || m.reach === 'write' || m.reach === 'manage';
}

/** The memories this board's tickets may put files into. */
export function writeMemories(
  list: readonly BoardMemoryOut[],
  attachMemory: BoardAttachMemory | null | undefined,
): BoardMemoryOut[] {
  return list.filter((m) => isWriteGranted(m, attachMemory));
}

/** The memory the attach dialog starts on: the board's default if still there, else the first. */
export function defaultMemoryId(
  list: readonly { id: string }[],
  attachMemory: BoardAttachMemory | null | undefined,
): string | null {
  if (attachMemory && list.some((m) => m.id === attachMemory.memoryId))
    return attachMemory.memoryId;
  return list[0]?.id ?? null;
}

/** The template for files going into `memoryId`: the board's own for its default memory. */
export function templateFor(
  memoryId: string | null,
  attachMemory: BoardAttachMemory | null | undefined,
): string {
  return attachMemory && attachMemory.memoryId === memoryId
    ? attachMemory.template
    : DEFAULT_ATTACH_TEMPLATE;
}

export interface Prefill {
  /** '/tickets/ENG-42/20261005-211946_photo.png' */
  value: string;
  /** Where the file's own name sits in `value` (selected so typing renames it). */
  select: [number, number] | null;
}

/**
 * The path a file is offered. A template that no longer fills (it should not:
 * the server checks it) falls back to the default template.
 */
export function prefillPath(
  template: string,
  v: { ticketKey: string; at: number; random6: string; filename: string },
): Prefill {
  const filled = fillAttachTemplate(template, v) ?? fillAttachTemplate(DEFAULT_ATTACH_TEMPLATE, v);
  if (!filled) {
    const name = attachFileName(v.filename);
    return { value: '/' + name, select: [1, 1 + name.length] };
  }
  return {
    value: '/' + filled.path,
    select: filled.name ? [filled.name[0] + 1, filled.name[1] + 1] : null,
  };
}

/**
 * The name the TICKET shows for a file: the part of the path that stood for
 * <filename>, as the person left it. Prefilled '/t/ENG-1/20261005-211946_a.png'
 * edited to '…_invoice.pdf' → 'invoice.pdf'; untouched → 'a.png'. When the
 * path was reworked beyond that, its last segment.
 */
export function attachLabel(pre: Prefill, value: string): string {
  const v = value.trim();
  const base = v.slice(v.lastIndexOf('/') + 1);
  if (!pre.select) return attachFileName(base);
  const prefix = pre.value.slice(0, pre.select[0]);
  const suffix = pre.value.slice(pre.select[1]);
  if (v.length > prefix.length + suffix.length && v.startsWith(prefix) && v.endsWith(suffix)) {
    const middle = v.slice(prefix.length, v.length - suffix.length).trim();
    if (middle && !middle.includes('/')) return attachFileName(middle);
  }
  return attachFileName(base);
}

/** A typed path → the memory path (no leading '/'), or null when it can't be one. */
export function resolveAttachPath(value: string): string | null {
  const t = value.trim();
  if (!t || t === '/') return null;
  return normalizeMemoryPath(t);
}

/** Per typed path: why it can't be used, or null. Two files may not share a path. */
export function attachPathProblems(values: readonly string[]): (string | null)[] {
  const resolved = values.map(resolveAttachPath);
  return values.map((v, i) => {
    const t = v.trim();
    if (!t || t === '/') return 'Give it a path';
    for (const seg of t.replace(/\\/g, '/').split('/')) {
      const s = seg.trim();
      if (s === '.' || s === '..') return "'.' and '..' aren't allowed";
      if (s.length > 255) return 'A name is at most 255 characters';
    }
    const p = resolved[i];
    if (!p) return "That path can't be used";
    if (/[<>]/.test(p)) return "A path can't hold '<' or '>'";
    if (resolved.some((o, j) => j < i && o === p)) return 'Two files would get the same path';
    return null;
  });
}

/** Board settings: what one file would become, for the live example. */
export function examplePath(
  template: string,
  boardKey: string,
  at: number,
  filename = 'photo.png',
): string | null {
  if (attachTemplateProblem(template)) return null;
  const f = fillAttachTemplate(template, {
    ticketKey: `${boardKey}-42`,
    at,
    random6: 'k3x9q2',
    filename,
  });
  return f ? '/' + f.path : null;
}

/** An upload headed for a memory: the bytes' Storage path plus where the file goes. */
export interface MemoryBound {
  /** Storage path of the uploaded bytes (memories/{memoryId}/{fileId}/{name}). */
  path: string;
  memoryId?: string;
  /** The new file's path in the memory. */
  memoryPath?: string;
}

/** messagePost / ticketCreate `memoryUploads`. Anything not headed for a memory is dropped. */
export function toMemoryUploads(items: readonly MemoryBound[]): MemoryUpload[] {
  return items.flatMap((a) =>
    a.memoryId && a.memoryPath
      ? [{ memoryId: a.memoryId, path: a.memoryPath, storagePath: a.path }]
      : [],
  );
}
