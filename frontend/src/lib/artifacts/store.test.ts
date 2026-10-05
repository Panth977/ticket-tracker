/** The pure half of the artifacts store: the listing query and the role helpers every screen uses. */
import { describe, expect, it } from 'vitest';
import type { Artifact } from '@tm/shared';
import {
  accessRows,
  artifactGlyph,
  artifactPaths,
  firstSettingsSection,
  myArtifactsSpec,
  roleIn,
  settingsSectionsFor,
  shortBuild,
  splitArtifacts,
  viewerReadOnly,
} from './store';
import { buildEntries, buildProblem, BuildTooBig, zipFolder } from './zip';
import { unzipSync } from 'fflate';

const art = (over: Partial<Artifact> = {}): Artifact => ({
  name: 'Sales',
  description: null,
  icon: null,
  ownerUid: 'o',
  access: { o: 'owner', e: 'editor', v: 'viewer' },
  memberUids: ['e', 'o', 'v'],
  agents: {},
  readOnly: false,
  archivedAt: null,
  currentBuild: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('the listing query', () => {
  it('asks for the artifacts whose memberUids hold me — one provable query', () => {
    expect(myArtifactsSpec('u1')).toEqual({
      path: 'artifacts',
      where: [['memberUids', 'array-contains', 'u1']],
    });
  });
  it('paths follow §G', () => {
    expect(artifactPaths.artifact('a1')).toBe('artifacts/a1');
    expect(artifactPaths.builds('a1')).toBe('artifacts/a1/builds');
    expect(artifactPaths.build('a1', 'b1')).toBe('artifacts/a1/builds/b1');
  });
});

describe('roles', () => {
  it('roleIn reads the access map', () => {
    expect(roleIn(art(), 'o')).toBe('owner');
    expect(roleIn(art(), 'v')).toBe('viewer');
    expect(roleIn(art(), 'stranger')).toBeNull();
    expect(roleIn(art(), null)).toBeNull();
    expect(roleIn(null, 'o')).toBeNull();
  });

  it('viewerReadOnly: only viewers of a read-only artifact — and everyone on an archived one', () => {
    expect(viewerReadOnly(art(), 'viewer')).toBe(false);
    expect(viewerReadOnly(art({ readOnly: true }), 'viewer')).toBe(true);
    expect(viewerReadOnly(art({ readOnly: true }), 'editor')).toBe(false);
    expect(viewerReadOnly(art({ readOnly: true }), 'owner')).toBe(false);
    expect(viewerReadOnly(art({ archivedAt: 5 }), 'owner')).toBe(true);
    expect(viewerReadOnly(art(), null)).toBe(true);
  });

  it('settings: owners get every section (Board access too, §K), editors Builds and Data, viewers none', () => {
    expect(settingsSectionsFor('owner').map((s) => s.id)).toEqual([
      'general',
      'people',
      'boards',
      'builds',
      'data',
    ]);
    expect(settingsSectionsFor('editor').map((s) => s.id)).toEqual(['builds', 'data']);
    expect(settingsSectionsFor('viewer')).toEqual([]);
    expect(settingsSectionsFor(null)).toEqual([]);
    expect(firstSettingsSection('owner')).toBe('general');
    expect(firstSettingsSection('editor')).toBe('builds');
    expect(firstSettingsSection('viewer')).toBeNull();
  });

  it('accessRows: owner, editors, viewers', () => {
    expect(
      accessRows(art({ access: { v: 'viewer', e: 'editor', o: 'owner', a: 'editor' } })),
    ).toEqual([
      { uid: 'o', role: 'owner' },
      { uid: 'a', role: 'editor' },
      { uid: 'e', role: 'editor' },
      { uid: 'v', role: 'viewer' },
    ]);
  });
});

describe('lists', () => {
  it('splitArtifacts: active by name, archived newest first, input untouched', () => {
    const list = [
      art({ name: 'zeta' }),
      art({ name: 'Old', archivedAt: 10 }),
      art({ name: 'alpha' }),
      art({ name: 'Older', archivedAt: 5 }),
    ];
    const { active, archived } = splitArtifacts(list);
    expect(active.map((a) => a.name)).toEqual(['alpha', 'zeta']);
    expect(archived.map((a) => a.name)).toEqual(['Old', 'Older']);
    expect(list[0]!.name).toBe('zeta');
  });

  it('glyph and short build id', () => {
    expect(artifactGlyph(art({ icon: '📊' }))).toBe('📊');
    expect(artifactGlyph(art())).toBe('◆');
    expect(shortBuild('a1B2c3D4e5')).toBe('a1B2c3');
    expect(shortBuild(null)).toBe('');
  });
});

describe('publishing a folder', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('zips what the server would accept and skips the rest', () => {
    const zip = zipFolder([
      { path: 'dist/index.html', bytes: bytes('<h1>hi</h1>') },
      { path: 'dist/assets/app.js', bytes: bytes('1') },
      { path: 'dist/.DS_Store', bytes: bytes('x') },
      { path: '__MACOSX/dist/index.html', bytes: bytes('x') },
      { path: 'dist/node_modules/pkg/index.js', bytes: bytes('x') },
    ]);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(['dist/assets/app.js', 'dist/index.html']);
    expect(new TextDecoder().decode(back['dist/index.html'])).toBe('<h1>hi</h1>');
  });

  it('refuses a path that escapes the folder', () => {
    expect(() => buildEntries([{ path: '../evil.js' }])).toThrow();
    expect(() => buildEntries([{ path: '/etc/passwd' }])).toThrow();
  });

  it('says why a folder cannot be a build before anything is uploaded', () => {
    expect(buildProblem([])).toMatch(/no files/);
    expect(buildProblem([{ path: 'app.js', size: 1 }])).toMatch(/index\.html/);
    expect(buildProblem([{ path: 'a/b/index.html', size: 1 }])).toMatch(/index\.html/);
    expect(buildProblem([{ path: 'index.html', size: 1 }])).toBeNull();
    expect(buildProblem([{ path: 'dist/index.html', size: 1 }])).toBeNull();
    expect(buildProblem([{ path: 'index.html', size: 26 * 1024 * 1024 }])).toMatch(/25 MB/);
    expect(
      buildProblem(
        Array.from({ length: 2001 }, (_, i) => ({ path: i ? `f${i}` : 'index.html', size: 1 })),
      ),
    ).toMatch(/2,000|2000/);
    expect(() => zipFolder([{ path: 'readme.txt', bytes: bytes('x') }])).toThrow(BuildTooBig);
  });
});
