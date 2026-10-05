import { describe, expect, it } from 'vitest';
import {
  absoluteAssetWarning,
  artifactBuildFile,
  artifactFirestoreCollection,
  artifactFirestoreDoc,
  artifactFirestoreRelative,
  artifactKvDoc,
  ArtifactPathError,
  artifactRtdbPath,
  artifactStorageFile,
  artifactStoragePrefix,
  artifactZipEntry,
  splitArtifactPath,
  stripSingleTopFolder,
} from './paths.js';
import { artifactCan } from './schema.js';
import { isDriverMessage, SERVER_TIME, isServerTime } from './driver.js';

const A = 'art123';

describe('the fence: every path lands under the artifact', () => {
  it('Firestore documents and collections', () => {
    expect(artifactFirestoreDoc(A, '/my/doc')).toBe('artifacts/art123/db/data/my/doc');
    expect(artifactFirestoreDoc(A, 'my//doc/')).toBe('artifacts/art123/db/data/my/doc');
    expect(artifactFirestoreCollection(A, '/my')).toBe('artifacts/art123/db/data/my');
    expect(artifactFirestoreCollection(A, 'my/doc/items')).toBe(
      'artifacts/art123/db/data/my/doc/items',
    );
    expect(artifactFirestoreRelative(A, 'artifacts/art123/db/data/my/doc')).toBe('/my/doc');
  });
  it('odd/even segment counts are enforced', () => {
    expect(() => artifactFirestoreDoc(A, '/my')).toThrow(ArtifactPathError);
    expect(() => artifactFirestoreDoc(A, '/')).toThrow(ArtifactPathError);
    expect(() => artifactFirestoreCollection(A, '/my/doc')).toThrow(ArtifactPathError);
    expect(() => artifactFirestoreCollection(A, '')).toThrow(ArtifactPathError);
  });
  it('refuses every way out', () => {
    for (const bad of ['../x', '/a/../../b', './a/b', 'a/./b', '..', '/my/..']) {
      expect(() => artifactFirestoreDoc(A, bad), bad).toThrow(ArtifactPathError);
      expect(() => artifactRtdbPath(A, bad), bad).toThrow(ArtifactPathError);
      expect(() => artifactStorageFile(A, bad), bad).toThrow(ArtifactPathError);
    }
    expect(() => artifactFirestoreDoc(A, '/__name__/x')).toThrow(ArtifactPathError);
    expect(() => artifactFirestoreDoc(A, 'x'.repeat(2000))).toThrow(ArtifactPathError);
    expect(() => splitArtifactPath(42)).toThrow(ArtifactPathError);
    expect(() => splitArtifactPath({ toString: () => '../x' })).toThrow(ArtifactPathError);
  });
  it('reserved collection names are refused, as ids they are fine', () => {
    expect(() => artifactFirestoreCollection(A, '/tickets')).toThrow(/reserved/);
    expect(() => artifactFirestoreDoc(A, '/my/doc/reads/x')).toThrow(/reserved/);
    expect(artifactFirestoreDoc(A, '/my/tickets')).toBe('artifacts/art123/db/data/my/tickets');
  });
  it('RTDB', () => {
    expect(artifactRtdbPath(A, '')).toBe('artifactData/art123');
    expect(artifactRtdbPath(A, '/')).toBe('artifactData/art123');
    expect(artifactRtdbPath(A, '/votes/a')).toBe('artifactData/art123/votes/a');
    for (const bad of ['a.b', 'a$', 'x#', 'a[0]'])
      expect(() => artifactRtdbPath(A, bad)).toThrow(ArtifactPathError);
  });
  it('Storage', () => {
    expect(artifactStorageFile(A, '/img/a.png')).toBe('artifacts/art123/files/img/a.png');
    expect(() => artifactStorageFile(A, '/')).toThrow(ArtifactPathError);
    expect(artifactStoragePrefix(A, '')).toBe('artifacts/art123/files/');
    expect(artifactStoragePrefix(A, 'img')).toBe('artifacts/art123/files/img/');
  });
  it('kv keys are one id', () => {
    expect(artifactKvDoc(A, 'u1', 'theme')).toBe('artifacts/art123/viewers/u1/kv/theme');
    for (const bad of ['', 'a/b', '..', '__x__'])
      expect(() => artifactKvDoc(A, 'u1', bad)).toThrow(ArtifactPathError);
  });
});

describe('publishing', () => {
  it('zip entries', () => {
    expect(artifactZipEntry('index.html')).toBe('index.html');
    expect(artifactZipEntry('dist/assets/a.js')).toBe('dist/assets/a.js');
    expect(artifactZipEntry('dist/')).toBeNull();
    expect(artifactZipEntry('__MACOSX/x')).toBeNull();
    expect(artifactZipEntry('a/.DS_Store')).toBeNull();
    expect(artifactZipEntry('a\\b.js')).toBe('a/b.js');
    expect(() => artifactZipEntry('../evil')).toThrow(ArtifactPathError);
    expect(() => artifactZipEntry('/etc/passwd')).toThrow(ArtifactPathError);
    expect(() => artifactZipEntry('C:/x')).toThrow(ArtifactPathError);
  });
  it('a single top folder is stripped', () => {
    expect(stripSingleTopFolder(['dist/index.html', 'dist/assets/a.js'])).toEqual([
      'index.html',
      'assets/a.js',
    ]);
    expect(stripSingleTopFolder(['index.html', 'a.js'])).toEqual(['index.html', 'a.js']);
    expect(stripSingleTopFolder(['a/index.html', 'b/x.js'])).toEqual(['a/index.html', 'b/x.js']);
  });
  it('build file paths', () => {
    expect(artifactBuildFile('')).toBe('index.html');
    expect(artifactBuildFile('/assets/a.js')).toBe('assets/a.js');
    expect(() => artifactBuildFile('../x')).toThrow(ArtifactPathError);
  });
  it('warns on absolute asset paths only', () => {
    expect(absoluteAssetWarning('<script src="/assets/a.js"></script>')).toMatch(/base/);
    expect(absoluteAssetWarning('<script src="./assets/a.js"></script>')).toBeNull();
    expect(absoluteAssetWarning('<script src="https://cdn.x/a.js"></script>')).toBeNull();
    expect(absoluteAssetWarning('<script src="//cdn.x/a.js"></script>')).toBeNull();
  });
});

describe('roles', () => {
  it('matches the §B table', () => {
    expect(artifactCan.writeData('viewer', false)).toBe(true);
    expect(artifactCan.writeData('viewer', true)).toBe(false);
    expect(artifactCan.writeData('editor', true)).toBe(true);
    expect(artifactCan.publish('viewer')).toBe(false);
    expect(artifactCan.manage('editor')).toBe(false);
    expect(artifactCan.open(null)).toBe(false);
  });
});

describe('protocol', () => {
  it('recognises its own messages only', () => {
    expect(isDriverMessage({ tag: 'tm-artifact', v: 1, type: 'ready' })).toBe(true);
    expect(isDriverMessage({ tag: 'tm-artifact', v: 2, type: 'ready' })).toBe(false);
    expect(isDriverMessage({ type: 'ready' })).toBe(false);
    expect(isServerTime(SERVER_TIME)).toBe(true);
    expect(isServerTime({})).toBe(false);
  });
});
