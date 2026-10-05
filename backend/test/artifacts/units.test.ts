/**
 * Artifact pieces that need no emulator (docs/plan/artifacts.html §C1, §D2):
 * the capability's signature, the zip reader's refusals, the build's shape
 * and the content types the /c route will answer with.
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_BUILD_MAX_BYTES,
  ARTIFACT_CAPABILITY_TTL_MS,
  ARTIFACT_INLINE_MAX_BYTES,
} from '@tm/shared';
import {
  artifactOrigin,
  buildUrls,
  objectUrl,
  signCapability,
  verifyCapability,
} from '../../src/artifacts/capability.js';
import {
  contentTypeFor,
  finishPlan,
  planFromInline,
  planFromZip,
} from '../../src/artifacts/publish.js';
import { openZip } from '../../src/artifacts/unzip.js';
import { agentAccessFor, roleFor } from '../../src/artifacts/shared.js';
import { makeZip, SITE } from './zip.js';

const NOW = 1_800_000_000_000;
const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 20 };

describe('the capability', () => {
  const cap = { artifactId: 'art_1', buildId: 'build_1', uid: 'u1', exp: NOW + 1000 };

  it('round-trips, for a build and for one object', () => {
    expect(verifyCapability(signCapability(cap), NOW)).toEqual({ ok: true, cap });
    const obj = { artifactId: 'art_1', object: 'files/a/b.png', uid: 'u1', exp: NOW + 1000 };
    expect(verifyCapability(signCapability(obj), NOW)).toEqual({ ok: true, cap: obj });
  });

  it('is URL-safe: it is a path segment in every asset URL', () => {
    expect(signCapability(cap)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('expires', () => {
    const token = signCapability(cap);
    expect(verifyCapability(token, cap.exp - 1).ok).toBe(true);
    expect(verifyCapability(token, cap.exp)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyCapability(token, cap.exp + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a tampered body, a tampered signature and a swapped half', () => {
    const token = signCapability(cap);
    const [body, sig] = token.split('.') as [string, string];
    // The same fields pointing at somebody else's artifact, re-encoded, old signature.
    const forged = Buffer.from(
      JSON.stringify({ a: 'art_OTHER', u: 'u1', e: cap.exp, b: 'build_1' }),
    ).toString('base64url');
    const later = Buffer.from(
      JSON.stringify({ a: 'art_1', u: 'u1', e: cap.exp + 10 ** 9, b: 'build_1' }),
    ).toString('base64url');
    const other = signCapability({ ...cap, artifactId: 'art_2' }).split('.') as [string, string];
    for (const bad of [
      `${forged}.${sig}`,
      `${later}.${sig}`,
      `${body}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`,
      `${body}.${other[1]}`,
      `${other[0]}.${sig}`,
      `${body}.`,
      `.${sig}`,
      body,
      '',
      `${body}.${sig}.${sig}`,
      'not a token',
    ])
      expect(verifyCapability(bad, NOW), bad).toEqual({ ok: false, reason: 'invalid' });
  });

  it('names exactly one thing: a build OR an object, never both', () => {
    // Handed both, signCapability writes the build and drops the object.
    const both = verifyCapability(signCapability({ ...cap, object: 'files/x' } as never), NOW);
    expect(both).toEqual({ ok: true, cap });
  });

  it('artifactOpen’s URLs: one prefix on the usercontent origin, an hour long', () => {
    const u = buildUrls('art_1', 'build_1', 'u1', NOW);
    expect(u.expiresAt).toBe(NOW + ARTIFACT_CAPABILITY_TTL_MS);
    expect(u.contentBase.startsWith(`${artifactOrigin()}/c/`)).toBe(true);
    expect(u.contentBase.endsWith('/')).toBe(true);
    expect(u.contentUrl).toBe(`${u.contentBase}index.html`);
    const token = u.contentBase.split('/c/')[1]!.replace(/\/$/, '');
    expect(verifyCapability(token, NOW)).toMatchObject({
      ok: true,
      cap: { artifactId: 'art_1', buildId: 'build_1', uid: 'u1' },
    });
  });

  it('the origin: TM_ARTIFACT_ORIGIN, else the functions emulator’s api URL under the emulators', () => {
    const saved = process.env.TM_ARTIFACT_ORIGIN;
    try {
      delete process.env.TM_ARTIFACT_ORIGIN;
      expect(artifactOrigin()).toMatch(
        /^http:\/\/127\.0\.0\.1:5101\/demo-[a-z-]+\/us-central1\/api$/,
      );
      process.env.TM_ARTIFACT_ORIGIN = 'https://example-usercontent.web.app/';
      expect(artifactOrigin()).toBe('https://example-usercontent.web.app');
      expect(objectUrl('art_1', 'files/a b.png', 'u1', NOW + 1)).toMatch(
        /^https:\/\/example-usercontent\.web\.app\/c\/[^/]+\/a%20b\.png$/,
      );
    } finally {
      if (saved === undefined) delete process.env.TM_ARTIFACT_ORIGIN;
      else process.env.TM_ARTIFACT_ORIGIN = saved;
    }
  });
});

describe('roleFor — who is this, here', () => {
  const artifact = {
    access: { owner: 'owner', ed: 'editor', view: 'viewer' } as const,
    agents: { ag_0123456789abcdef: 'editor' } as const,
  };
  const person = (actor: string) => ({ actor });

  it('a person’s role is access[uid]; nobody else has one', () => {
    expect(roleFor(person('owner'), artifact)).toBe('owner');
    expect(roleFor(person('ed'), artifact)).toBe('editor');
    expect(roleFor(person('view'), artifact)).toBe('viewer');
    expect(roleFor(person('stranger'), artifact)).toBe(null);
    // A uid that happens to be a property of every object is still nobody.
    expect(roleFor(person('constructor'), artifact)).toBe(null);
    expect(roleFor(person('__proto__'), artifact)).toBe(null);
  });

  it('an agent is an editor iff it is in `agents` — never through `access`', () => {
    expect(roleFor(person('ag_0123456789abcdef'), artifact)).toBe('editor');
    expect(roleFor(person('ag_fedcba9876543210'), artifact)).toBe(null);
    expect(
      roleFor(person('ag_fedcba9876543210'), {
        access: { ag_fedcba9876543210: 'owner' },
        agents: {},
      }),
    ).toBe(null);
  });

  // §AA3 (agents.html): the value is { build, data } now; the literal above is the pre-§AA form.
  it('§AA3: an agent with ANY permission is on it; { build: false, data: none } is not', () => {
    const agents = {
      ag_Bui1dOn1y0000001: { build: true, data: 'none' },
      ag_ReadOn1y00000001: { build: false, data: 'read' },
      ag_Wr1teOn1y0000001: { build: false, data: 'write' },
      ag_Noth1ng000000001: { build: false, data: 'none' },
      ag_0123456789abcdef: 'editor',
    } as const;
    const a = { access: { owner: 'owner' } as const, agents };
    for (const id of ['ag_Bui1dOn1y0000001', 'ag_ReadOn1y00000001', 'ag_Wr1teOn1y0000001', 'ag_0123456789abcdef'])
      expect(roleFor(person(id), a)).toBe('editor');
    expect(roleFor(person('ag_Noth1ng000000001'), a)).toBe(null);
    // What it may actually do is its own { build, data } — the legacy literal reads as both.
    expect(agentAccessFor(person('ag_Bui1dOn1y0000001'), a)).toEqual({ build: true, data: 'none' });
    expect(agentAccessFor(person('ag_ReadOn1y00000001'), a)).toEqual({ build: false, data: 'read' });
    expect(agentAccessFor(person('ag_0123456789abcdef'), a)).toEqual({ build: true, data: 'write' });
    expect(agentAccessFor(person('ag_fedcba9876543210'), a)).toEqual({ build: false, data: 'none' });
    // A person has no agent access at all (null), whatever their role.
    expect(agentAccessFor(person('owner'), a)).toBe(null);
  });

  it('tokens narrow: an account token reaches owner/editor, never viewer; a board token nothing', () => {
    const account = (actor: string) => ({
      actor,
      scopes: ['artifacts:write'] as const,
      keyId: 'k',
      boardIds: null,
    });
    expect(roleFor(account('owner'), artifact)).toBe('owner');
    expect(roleFor(account('ed'), artifact)).toBe('editor');
    expect(roleFor(account('view'), artifact)).toBe(null);
    const board = {
      actor: 'owner',
      scopes: ['artifacts:write'] as const,
      keyId: 'k',
      boardIds: ['b1'],
    };
    expect(roleFor(board, artifact)).toBe(null);
  });

  it('an artifact being deleted has no roles at all', () => {
    expect(roleFor(person('owner'), { ...artifact, deletingAt: 5 })).toBe(null);
  });
});

describe('reading a zip', () => {
  it('lists the files of an honest zip and inflates them', async () => {
    const zip = await openZip(makeZip(SITE), LIMITS);
    expect(zip.files.map((f) => f.path)).toEqual(['index.html', 'assets/app.js', 'assets/app.css']);
    expect((await zip.files[1]!.read()).toString()).toBe('document.title = "hello";\n');
    zip.close();
    zip.close(); // twice is fine
  });

  it('skips directories, __MACOSX and .DS_Store; normalises backslashes', async () => {
    const zip = await openZip(
      makeZip([
        { name: 'dist/', data: '' },
        { name: 'dist/index.html', data: 'x' },
        { name: '__MACOSX/dist/._index.html', data: 'junk' },
        { name: 'dist/.DS_Store', data: 'junk' },
        { name: 'dist\\assets\\a.js', data: 'y' },
      ]),
      LIMITS,
    );
    expect(zip.files.map((f) => f.path)).toEqual(['dist/index.html', 'dist/assets/a.js']);
    zip.close();
  });

  it.each([
    ['../evil.txt'],
    ['a/../../evil.txt'],
    ['/etc/passwd'],
    ['C:/Windows/evil.dll'],
    ['..\\evil.txt'],
  ])('zip-slip: refuses the entry %s', async (name) => {
    await expect(
      openZip(
        makeZip([
          { name: 'index.html', data: 'x' },
          { name, data: 'pwn' },
        ]),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses a symlink', async () => {
    await expect(
      openZip(
        makeZip([
          { name: 'index.html', data: 'x' },
          { name: 'link', data: '/etc/passwd', method: 'store', mode: 0o120777 },
        ]),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Symlink') });
  });

  it('an honest zip that declares too much is refused from the directory alone', async () => {
    // 4 MB of zeros deflates to a few KB; nothing is inflated to find out.
    const big = makeZip([{ name: 'index.html', data: new Uint8Array(4 * 1024 * 1024) }]);
    expect(big.length).toBeLessThan(64 * 1024);
    await expect(openZip(big, LIMITS)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('A ZIP BOMB — little declared, a lot inflated — is cut off while it inflates', async () => {
    const bomb = makeZip([
      { name: 'index.html', data: new Uint8Array(8 * 1024 * 1024), declaredSize: 100 },
    ]);
    const zip = await openZip(bomb, LIMITS); // the directory looks innocent
    expect(zip.files[0]!.size).toBe(100);
    const err = await zip.files[0]!.read().catch((e: unknown) => e);
    expect(['invalid', 'too_large']).toContain((err as { code: string }).code);
    zip.close();
  });

  it('several files that are each fine but TOGETHER too much', async () => {
    const half = new Uint8Array(600 * 1024);
    await expect(
      openZip(
        makeZip([
          { name: 'index.html', data: half },
          { name: 'b.bin', data: half },
        ]),
        LIMITS,
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('too many files', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
    await expect(openZip(makeZip(many), LIMITS)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('garbage is not a zip', async () => {
    await expect(openZip(Buffer.from('definitely not a zip'), LIMITS)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(openZip(Buffer.alloc(0), LIMITS)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('the shape of a build', () => {
  const file = (path: string, size = 1) => ({ path, size, read: async () => Buffer.alloc(size) });

  it('strips a single top folder — a zipped dist/', async () => {
    const plan = await planFromZip(
      makeZip([
        { name: 'dist/index.html', data: 'x' },
        { name: 'dist/assets/a.js', data: 'y' },
      ]),
    );
    expect(finishPlan(plan.files).map((f) => f.path)).toEqual(['index.html', 'assets/a.js']);
    plan.close();
  });

  it('needs an index.html at the root', () => {
    expect(() => finishPlan([file('app.js')])).toThrowError(/index\.html/);
    expect(() => finishPlan([file('a/index.html'), file('b/x.js')])).toThrowError(/index\.html/);
    expect(() => finishPlan([])).toThrowError(/empty/);
  });

  it('refuses two files with one path, and a build over the limit', () => {
    expect(() => finishPlan([file('index.html'), file('index.html')])).toThrowError(/Two files/);
    expect(() =>
      finishPlan([file('index.html'), file('big.bin', ARTIFACT_BUILD_MAX_BYTES)]),
    ).toThrowError(/MB unpacked/);
  });

  it('inline files: the same name rules, utf8 and base64, and the 5 MB limit', () => {
    const plan = planFromInline([
      { path: './index.html', content: '<p>hi</p>', encoding: 'utf8' },
      {
        path: 'img/dot.png',
        content: Buffer.from([1, 2, 3]).toString('base64'),
        encoding: 'base64',
      },
    ]);
    expect(plan.files.map((f) => [f.path, f.size])).toEqual([
      ['index.html', 9],
      ['img/dot.png', 3],
    ]);
    expect(() =>
      planFromInline([{ path: '../up.html', content: 'x', encoding: 'utf8' }]),
    ).toThrowError(/'\.\.'/);
    expect(() =>
      planFromInline([{ path: 'a.png', content: 'not base64!!', encoding: 'base64' }]),
    ).toThrowError(/base64/);
    expect(() =>
      planFromInline([
        {
          path: 'index.html',
          content: 'x'.repeat(ARTIFACT_INLINE_MAX_BYTES + 1),
          encoding: 'utf8',
        },
      ]),
    ).toThrowError(/Inline files/);
  });

  it('content types are chosen by extension — the ones a browser refuses when wrong', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('assets/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('assets/chunk.MJS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a/b/app.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('app.js.map')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('mod.wasm')).toBe('application/wasm');
    expect(contentTypeFor('f.woff2')).toBe('font/woff2');
    expect(contentTypeFor('pic.PNG')).toBe('image/png');
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
    expect(contentTypeFor('.htaccess')).toBe('application/octet-stream');
    expect(contentTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});
