import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/firebase/client', () => ({ getStorageClient: () => ({}) }));
vi.mock('$lib/api', () => ({ command: vi.fn() }));

import { languageFor } from './codemirror';
import {
  ancestorsOf,
  buildTree,
  childrenOf,
  crumbs,
  folderPaths,
  freeName,
  movedPath,
  nameProblem,
  placeProblem,
  resolveTypedPath,
  typedPathProblem,
  subtreeStats,
  uploadTarget,
  type Node,
} from './tree';
import { memoryRejectReason, newFileId, objectPathFor } from './upload.svelte';
import { memorySettingsFor, splitMemories } from './store';

const node = (path: string, kind: 'file' | 'folder' = 'file', size = 10): Node => ({
  id: 'n_' + path.replace(/\W/g, '_'),
  kind,
  parentId: null,
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  file: kind === 'file' ? { fileId: 'f12345', storagePath: 'x', mime: 'text/plain', size } : null,
  createdAt: 1,
  createdBy: 'u',
  updatedAt: 1,
  updatedBy: 'u',
});

const nodes = [
  node('docs', 'folder'),
  node('docs/b.md'),
  node('docs/a.md'),
  node('docs/img', 'folder'),
  node('docs/img/logo.png', 'file', 100),
  node('file10.txt'),
  node('file2.txt'),
  node('zeta', 'folder'),
];

describe('memory trees (memory.html §A)', () => {
  it('builds the tree by path, folders first and names natural', () => {
    const t = buildTree(nodes);
    expect(t.map((x) => x.node.path)).toEqual(['docs', 'zeta', 'file2.txt', 'file10.txt']);
    expect(t[0]!.children.map((x) => x.node.name)).toEqual(['img', 'a.md', 'b.md']);
    expect(t[0]!.children[0]!.children.map((x) => x.node.name)).toEqual(['logo.png']);
  });
  it('a node whose folder row is missing still shows, at the root', () => {
    const t = buildTree([node('ghost/x.md')]);
    expect(t.map((x) => x.node.path)).toEqual(['ghost/x.md']);
  });
  it('children, crumbs and ancestors', () => {
    expect(childrenOf(nodes, 'docs').map((n) => n.name)).toEqual(['img', 'a.md', 'b.md']);
    expect(childrenOf(nodes, '').map((n) => n.name)).toEqual([
      'docs',
      'zeta',
      'file2.txt',
      'file10.txt',
    ]);
    expect(crumbs('docs/img/logo.png').map((c) => c.path)).toEqual([
      'docs',
      'docs/img',
      'docs/img/logo.png',
    ]);
    expect(ancestorsOf('docs/img/logo.png')).toEqual(['docs', 'docs/img']);
    expect(ancestorsOf('top.md')).toEqual([]);
  });
  it('the move dialog never offers a folder inside itself', () => {
    expect(folderPaths(nodes, 'docs')).toEqual(['', 'zeta']);
    expect(folderPaths(nodes)).toEqual(['', 'docs', 'docs/img', 'zeta']);
    expect(movedPath(node('docs/a.md'), 'zeta')).toBe('zeta/a.md');
    expect(movedPath(node('docs/a.md'), '')).toBe('a.md');
  });
  it('finds a free name, keeping the extension', () => {
    expect(freeName(nodes, 'docs', 'c.md')).toBe('c.md');
    expect(freeName(nodes, 'docs', 'a.md')).toBe('a 2.md');
    expect(freeName([...nodes, node('docs/a 2.md')], 'docs', 'a.md')).toBe('a 3.md');
    expect(freeName(nodes, '', 'docs')).toBe('docs 2');
  });
  it('checks names like the server does', () => {
    expect(nameProblem('ok.md')).toBeNull();
    expect(nameProblem('  ')).toBeTruthy();
    expect(nameProblem('a/b')).toBeTruthy();
    expect(nameProblem('..')).toBeTruthy();
  });
  it('upload targets join the folder and the dropped relative path', () => {
    expect(uploadTarget('docs', 'photos/2024/a.jpg')).toBe('docs/photos/2024/a.jpg');
    expect(uploadTarget('', 'a.jpg')).toBe('a.jpg');
    expect(uploadTarget('docs', '../x')).toBeNull();
  });
  it('sums a subtree', () => {
    expect(subtreeStats(nodes, 'docs')).toEqual({ files: 3, bytes: 120 });
    expect(subtreeStats(nodes, '')).toEqual({ files: 5, bytes: 140 });
  });
});

describe('uploads', () => {
  it('file ids fit the schema and objects live under the memory', () => {
    expect(newFileId()).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(objectPathFor('mem123', 'file99', 'a/b?.png')).toBe('memories/mem123/file99/a_b_.png');
    expect(memoryRejectReason({ size: 5 })).toBeNull();
    expect(memoryRejectReason({ size: 2 * 1024 ** 3 })).toMatch(/limited/);
  });
});

describe('code mode', () => {
  it('picks a language from the file name', () => {
    expect(languageFor('README.md')).toBe('markdown');
    expect(languageFor('a.ts')).toBe('typescript');
    expect(languageFor('a.tsx')).toBe('tsx');
    expect(languageFor('a.json')).toBe('json');
    expect(languageFor('index.html')).toBe('html');
    expect(languageFor('s.css')).toBe('css');
    expect(languageFor('x.py')).toBe('python');
    expect(languageFor('Makefile')).toBe('plain');
  });
});

describe('store helpers', () => {
  it('splits active and archived', () => {
    const r = splitMemories([
      { name: 'b', archivedAt: null },
      { name: 'a', archivedAt: null },
      { name: 'z', archivedAt: 5 },
    ]);
    expect(r.active.map((m) => m.name)).toEqual(['a', 'b']);
    expect(r.archived.map((m) => m.name)).toEqual(['z']);
  });
  it('settings: the owner sees all, others only Subscribers', () => {
    expect(memorySettingsFor('owner').map((s) => s.id)).toEqual([
      'general',
      'people',
      'subscribers',
    ]);
    expect(memorySettingsFor('viewer').map((s) => s.id)).toEqual(['subscribers']);
    expect(memorySettingsFor(null)).toEqual([]);
  });
});

describe('typed names may be paths (rename / new / upload)', () => {
  it("resolves '/' as folders, a leading '/' from the top", () => {
    expect(resolveTypedPath('notes.md', 'docs')).toBe('docs/notes.md');
    expect(resolveTypedPath('drafts/notes.md', 'docs')).toBe('docs/drafts/notes.md');
    expect(resolveTypedPath('/notes.md', 'docs')).toBe('notes.md');
    expect(resolveTypedPath(' a // b ', '')).toBe('a/b');
    expect(resolveTypedPath('/', 'docs')).toBeNull();
  });
  it('says what is wrong with a typed path', () => {
    expect(typedPathProblem('', 'docs')).toBe('Give it a name');
    expect(typedPathProblem('a/../b', '')).toMatch(/aren't allowed/);
    expect(typedPathProblem('a/b.md', 'docs')).toBeNull();
  });
  it('refuses clashes, files in the way and a folder into itself', () => {
    const nodes = [node('docs', 'folder'), node('docs/a.md'), node('x.md')];
    const docs = nodes[0]!;
    expect(placeProblem(nodes, 'docs/a.md', null)).toMatch(/file with that name/);
    expect(placeProblem(nodes, 'x.md/y.md', null)).toMatch(/is a file/);
    expect(placeProblem(nodes, 'docs/sub/docs', docs)).toMatch(/inside itself/);
    expect(placeProblem(nodes, 'docs', docs)).toBeNull();
    expect(placeProblem(nodes, 'archive/docs', docs)).toBeNull();
  });
});
