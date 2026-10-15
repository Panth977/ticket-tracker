import { describe, expect, it } from 'vitest';
import {
  bucketArtifactReach,
  bucketPreviewKind,
  bucketReach,
  normalizeBucketPath,
  bucketParentPath,
  bucketPathWithin,
  splitBucketPath,
  isBucketTextFile,
  type Bucket,
} from './schema.js';
import {
  bucketRefPath,
  parseBucketRefPath,
  parseMemoryStoragePath,
  bucketStoragePath,
} from './paths.js';
import type { BoardRole } from '../types/index.js';

const mem = (over: Partial<Bucket> = {}): Bucket => ({
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

describe('bucketReach (bucket.html §B, §D)', () => {
  it('own roles: owner manages, editor writes, viewer reads, a stranger gets nothing', () => {
    expect(bucketReach(mem(), { uid: 'u_owner' })).toBe('manage');
    expect(bucketReach(mem(), { uid: 'u_ed' })).toBe('write');
    expect(bucketReach(mem(), { uid: 'u_view' })).toBe('read');
    expect(bucketReach(mem(), { uid: 'u_x' })).toBeNull();
  });
  it("a board 'read' grant gives every member read; 'write' gives editors and admins write", () => {
    expect(bucketReach(mem(), { uid: 'u_x', boardRoles: roles({ b_read: 'admin' }) })).toBe('read');
    expect(bucketReach(mem(), { boardRoles: roles({ b_write: 'editor' }) })).toBe('write');
    expect(bucketReach(mem(), { boardRoles: roles({ b_write: 'commenter' }) })).toBe('read');
    expect(bucketReach(mem(), { boardRoles: roles({ b_write: 'viewer' }) })).toBe('read');
    expect(bucketReach(mem(), { boardRoles: roles({ b_other: 'admin' }) })).toBeNull();
  });
  it('the best route wins', () => {
    expect(bucketReach(mem(), { uid: 'u_view', boardRoles: roles({ b_write: 'admin' }) })).toBe(
      'write',
    );
  });
  it('archived is read-only (the owner still manages); deleting reaches nobody', () => {
    expect(bucketReach(mem({ archivedAt: 5 }), { uid: 'u_ed' })).toBe('read');
    expect(bucketReach(mem({ archivedAt: 5 }), { uid: 'u_owner' })).toBe('manage');
    expect(bucketReach(mem({ deletingAt: 5 }), { uid: 'u_owner' })).toBeNull();
  });
  it('an artifact grant is a ceiling over the viewer', () => {
    expect(bucketArtifactReach(mem(), 'a2', 'write')).toBe('write');
    expect(bucketArtifactReach(mem(), 'a2', 'read')).toBe('read');
    expect(bucketArtifactReach(mem(), 'a1', 'manage')).toBe('read');
    expect(bucketArtifactReach(mem(), 'a3', 'manage')).toBeNull();
    expect(bucketArtifactReach(mem(), 'a2', null)).toBeNull();
  });
});

describe('paths inside a bucket', () => {
  it('normalizes what people type', () => {
    expect(normalizeBucketPath('/docs//brand/ logo.svg ')).toBe('docs/brand/logo.svg');
    expect(normalizeBucketPath('a\\b')).toBe('a/b');
    expect(normalizeBucketPath('')).toBe('');
    expect(normalizeBucketPath('a/../b')).toBeNull();
  });
  it('splits, finds parents and containment', () => {
    expect(splitBucketPath('a/b')).toEqual(['a', 'b']);
    expect(splitBucketPath(Array(33).fill('x').join('/'))).toBeNull();
    expect(bucketParentPath('a/b/c')).toBe('a/b');
    expect(bucketParentPath('a')).toBe('');
    expect(bucketPathWithin('a/b', 'a')).toBe(true);
    expect(bucketPathWithin('ab', 'a')).toBe(false);
    expect(bucketPathWithin('x', '')).toBe(true);
  });
  it('storage objects and ticket references round-trip', () => {
    expect(parseMemoryStoragePath(bucketStoragePath('bucket1', 'file01', 'a b.png'))).toEqual({
      bucketId: 'bucket1',
      fileId: 'file01',
      fileName: 'a b.png',
    });
    expect(parseBucketRefPath(bucketRefPath('bucket1', 'node001'))).toEqual({
      bucketId: 'bucket1',
      nodeId: 'node001',
    });
    // a ref path is never mistaken for a storage object, nor the reverse
    expect(parseMemoryStoragePath(bucketRefPath('bucket1', 'node001'))).toBeNull();
    expect(parseBucketRefPath(bucketStoragePath('bucket1', 'file01', 'x'))).toBeNull();
  });
});

describe('previews', () => {
  it('picks a preview from name and mime', () => {
    expect(bucketPreviewKind('README.md', 'application/octet-stream')).toBe('markdown');
    expect(bucketPreviewKind('a.png', 'image/png')).toBe('image');
    expect(bucketPreviewKind('a.mp4', 'video/mp4')).toBe('video');
    expect(bucketPreviewKind('a.pdf', 'application/pdf')).toBe('pdf');
    expect(bucketPreviewKind('main.ts', 'application/octet-stream')).toBe('text');
    expect(bucketPreviewKind('app.apk', 'application/vnd.android.package-archive')).toBe('other');
    expect(isBucketTextFile('logo.svg', 'image/svg+xml')).toBe(true);
    expect(isBucketTextFile('app.apk', 'application/zip')).toBe(false);
  });
});
