import { describe, expect, it } from 'vitest';
import {
  memoryArtifactReach,
  memoryPreviewKind,
  memoryReach,
  normalizeMemoryPath,
  memoryParentPath,
  memoryPathWithin,
  splitMemoryPath,
  isMemoryTextFile,
  type Memory,
} from './schema.js';
import {
  memoryRefPath,
  parseMemoryRefPath,
  parseMemoryStoragePath,
  memoryStoragePath,
} from './paths.js';
import type { BoardRole } from '../types/index.js';

const mem = (over: Partial<Memory> = {}): Memory => ({
  name: 'Brand',
  description: null,
  icon: null,
  ownerUid: 'u_owner',
  access: { u_owner: 'owner', u_ed: 'editor', u_view: 'viewer' },
  memberUids: ['u_owner', 'u_ed', 'u_view'],
  boards: { b_read: 'read', b_write: 'write' },
  artifacts: { a1: 'read', a2: 'write' },
  boardIds: ['b_read', 'b_write'],
  stats: { files: 0, folders: 0, bytes: 0 },
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const roles = (r: Record<string, BoardRole>) => new Map(Object.entries(r));

describe('memoryReach (memory.html §B, §D)', () => {
  it('own roles: owner manages, editor writes, viewer reads, a stranger gets nothing', () => {
    expect(memoryReach(mem(), { uid: 'u_owner' })).toBe('manage');
    expect(memoryReach(mem(), { uid: 'u_ed' })).toBe('write');
    expect(memoryReach(mem(), { uid: 'u_view' })).toBe('read');
    expect(memoryReach(mem(), { uid: 'u_x' })).toBeNull();
  });
  it("a board 'read' grant gives every member read; 'write' gives editors and admins write", () => {
    expect(memoryReach(mem(), { uid: 'u_x', boardRoles: roles({ b_read: 'admin' }) })).toBe('read');
    expect(memoryReach(mem(), { boardRoles: roles({ b_write: 'editor' }) })).toBe('write');
    expect(memoryReach(mem(), { boardRoles: roles({ b_write: 'commenter' }) })).toBe('read');
    expect(memoryReach(mem(), { boardRoles: roles({ b_write: 'viewer' }) })).toBe('read');
    expect(memoryReach(mem(), { boardRoles: roles({ b_other: 'admin' }) })).toBeNull();
  });
  it('the best route wins', () => {
    expect(memoryReach(mem(), { uid: 'u_view', boardRoles: roles({ b_write: 'admin' }) })).toBe(
      'write',
    );
  });
  it('archived is read-only (the owner still manages); deleting reaches nobody', () => {
    expect(memoryReach(mem({ archivedAt: 5 }), { uid: 'u_ed' })).toBe('read');
    expect(memoryReach(mem({ archivedAt: 5 }), { uid: 'u_owner' })).toBe('manage');
    expect(memoryReach(mem({ deletingAt: 5 }), { uid: 'u_owner' })).toBeNull();
  });
  it('an artifact grant is a ceiling over the viewer', () => {
    expect(memoryArtifactReach(mem(), 'a2', 'write')).toBe('write');
    expect(memoryArtifactReach(mem(), 'a2', 'read')).toBe('read');
    expect(memoryArtifactReach(mem(), 'a1', 'manage')).toBe('read');
    expect(memoryArtifactReach(mem(), 'a3', 'manage')).toBeNull();
    expect(memoryArtifactReach(mem(), 'a2', null)).toBeNull();
  });
});

describe('paths inside a memory', () => {
  it('normalizes what people type', () => {
    expect(normalizeMemoryPath('/docs//brand/ logo.svg ')).toBe('docs/brand/logo.svg');
    expect(normalizeMemoryPath('a\\b')).toBe('a/b');
    expect(normalizeMemoryPath('')).toBe('');
    expect(normalizeMemoryPath('a/../b')).toBeNull();
  });
  it('splits, finds parents and containment', () => {
    expect(splitMemoryPath('a/b')).toEqual(['a', 'b']);
    expect(splitMemoryPath(Array(33).fill('x').join('/'))).toBeNull();
    expect(memoryParentPath('a/b/c')).toBe('a/b');
    expect(memoryParentPath('a')).toBe('');
    expect(memoryPathWithin('a/b', 'a')).toBe(true);
    expect(memoryPathWithin('ab', 'a')).toBe(false);
    expect(memoryPathWithin('x', '')).toBe(true);
  });
  it('storage objects and ticket references round-trip', () => {
    expect(parseMemoryStoragePath(memoryStoragePath('memory1', 'file01', 'a b.png'))).toEqual({
      memoryId: 'memory1',
      fileId: 'file01',
      fileName: 'a b.png',
    });
    expect(parseMemoryRefPath(memoryRefPath('memory1', 'node001'))).toEqual({
      memoryId: 'memory1',
      nodeId: 'node001',
    });
    // a ref path is never mistaken for a storage object, nor the reverse
    expect(parseMemoryStoragePath(memoryRefPath('memory1', 'node001'))).toBeNull();
    expect(parseMemoryRefPath(memoryStoragePath('memory1', 'file01', 'x'))).toBeNull();
  });
});

describe('previews', () => {
  it('picks a preview from name and mime', () => {
    expect(memoryPreviewKind('README.md', 'application/octet-stream')).toBe('markdown');
    expect(memoryPreviewKind('a.png', 'image/png')).toBe('image');
    expect(memoryPreviewKind('a.mp4', 'video/mp4')).toBe('video');
    expect(memoryPreviewKind('a.pdf', 'application/pdf')).toBe('pdf');
    expect(memoryPreviewKind('main.ts', 'application/octet-stream')).toBe('text');
    expect(memoryPreviewKind('app.apk', 'application/vnd.android.package-archive')).toBe('other');
    expect(isMemoryTextFile('logo.svg', 'image/svg+xml')).toBe(true);
    expect(isMemoryTextFile('app.apk', 'application/zip')).toBe(false);
  });
});
