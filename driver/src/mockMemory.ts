/**
 * The mock's MEMORY (memory.html §H): one demo memory, 'demo-memory', with a
 * README and a folder, so BackendDriver.memory can be clicked through outside
 * TaskManager. Text files persist with the rest of the mock state; a Blob
 * written into it lives for the page only (like st.upload's files).
 *
 * Paths are checked by the same rules as the real ones (no '.', '..', empty
 * segments, '/' only as a separator), written out here so the bundle does not
 * pull in zod with the shared schema.
 */
import type { DriverMemory, DriverMemoryNode } from '@tm/shared/artifacts/driver';
import { fail } from './transport.js';

export const MOCK_MEMORY_ID = 'demo-memory';
const MAX_BYTES = 10 * 1024 * 1024;
const DEPTH_MAX = 32;

export interface MockMemoryNode {
  kind: 'folder' | 'file';
  /** Files only: the text, or null for a Blob kept in `blobs`. */
  text: string | null;
  mime: string | null;
  size: number | null;
  updatedAt: number;
}
/** path → node. */
export type MockMemoryState = Record<string, MockMemoryNode>;

export function seedMemory(now = Date.now()): MockMemoryState {
  const text = '# Demo memory\n\nFiles kept here are shared by tickets and artifacts.\n';
  return {
    docs: { kind: 'folder', text: null, mime: null, size: null, updatedAt: now },
    'docs/README.md': {
      kind: 'file',
      text,
      mime: 'text/markdown',
      size: new TextEncoder().encode(text).length,
      updatedAt: now,
    },
  };
}

export function mockMemoryInfo(state: MockMemoryState, readOnly: boolean): DriverMemory {
  const files = Object.values(state).filter((n) => n.kind === 'file');
  return {
    id: MOCK_MEMORY_ID,
    name: 'Demo memory',
    description: 'The mock backend’s memory',
    icon: null,
    access: readOnly ? 'read' : 'write',
    files: files.length,
    bytes: files.reduce((n, f) => n + (f.size ?? 0), 0),
  };
}

function memoryOf(id: unknown): void {
  if (id !== MOCK_MEMORY_ID)
    fail('permission-denied', `The mock has one memory, '${MOCK_MEMORY_ID}'`);
}

/** 'a//b/' → 'a/b'; throws invalid-argument on '.', '..' or too deep. */
export function mockMemoryPath(p: unknown, allowRoot = false): string {
  if (typeof p !== 'string') return fail('invalid-argument', 'A path must be a string');
  const segs = p
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segs.length && !allowRoot) fail('invalid-argument', 'A path is required');
  if (segs.length > DEPTH_MAX) fail('invalid-argument', 'Path too deep');
  for (const s of segs)
    if (s === '.' || s === '..' || s.length > 255)
      fail('invalid-argument', `'${s}' is not allowed in a path`);
  return segs.join('/');
}

const within = (p: string, folder: string) =>
  folder === '' || p === folder || p.startsWith(folder + '/');

function node(path: string, n: MockMemoryNode): DriverMemoryNode {
  return {
    id: `mock:${path}`,
    kind: n.kind,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    mime: n.mime,
    size: n.size,
    updatedAt: n.updatedAt,
  };
}

export function memoryTree(
  state: MockMemoryState,
  memory: unknown,
  path: unknown,
): DriverMemoryNode[] {
  memoryOf(memory);
  const root = mockMemoryPath(path ?? '', true);
  return Object.entries(state)
    .filter(([p]) => p !== root && within(p, root))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([p, n]) => node(p, n));
}

export function memoryFile(
  state: MockMemoryState,
  memory: unknown,
  path: unknown,
): [string, MockMemoryNode] {
  memoryOf(memory);
  const p = mockMemoryPath(path);
  const n = state[p];
  if (!n || n.kind !== 'file') fail('not-found', `No file at ${p}`);
  return [p, n!];
}

function mkdirs(state: MockMemoryState, path: string, now: number): void {
  const segs = path.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join('/');
    const cur = state[p];
    if (cur?.kind === 'file') fail('invalid-argument', `${p} is a file`);
    if (!cur) state[p] = { kind: 'folder', text: null, mime: null, size: null, updatedAt: now };
  }
}

export function memoryMkdir(state: MockMemoryState, memory: unknown, path: unknown): string {
  memoryOf(memory);
  const p = mockMemoryPath(path);
  mkdirs(state, p, Date.now());
  return p;
}

/** Write a file; a Blob's bytes go to the caller's map (returned null text). */
export function memoryWrite(
  state: MockMemoryState,
  memory: unknown,
  path: unknown,
  content: { text?: string; size?: number; mime?: string | null },
): string {
  memoryOf(memory);
  const p = mockMemoryPath(path);
  if (state[p]?.kind === 'folder') fail('invalid-argument', `${p} is a folder`);
  const size =
    content.text !== undefined
      ? new TextEncoder().encode(content.text).length
      : (content.size ?? 0);
  if (size > MAX_BYTES) fail('quota', 'A file written through the driver may be at most 10 MB');
  const now = Date.now();
  if (p.includes('/')) mkdirs(state, p.slice(0, p.lastIndexOf('/')), now);
  state[p] = {
    kind: 'file',
    text: content.text ?? null,
    mime: content.mime || (content.text !== undefined ? 'text/plain' : 'application/octet-stream'),
    size,
    updatedAt: now,
  };
  return p;
}

/** Remove a node and everything under it; returns the removed paths. */
export function memoryRemove(state: MockMemoryState, memory: unknown, path: unknown): string[] {
  memoryOf(memory);
  const p = mockMemoryPath(path);
  if (!state[p]) fail('not-found', `Nothing at ${p}`);
  const gone = Object.keys(state).filter((k) => within(k, p));
  for (const k of gone) delete state[k];
  return gone;
}
