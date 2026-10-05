/**
 * tm.artifacts.* against a mocked fetch (docs/plan/artifacts.html §C): the
 * verb, the path and the body of every route — and, for publish, the BYTES:
 * the zip the SDK makes is opened again here with node:zlib, the way the
 * server's reader opens it, so "it zipped something" is never the assertion.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARTIFACT_BUILD_MAX_BYTES,
  ARTIFACT_BUILD_MAX_FILES,
  ARTIFACT_ZIP_MAX_BYTES,
  REST_BUILD_FIELD,
  RestArtifactAccessBodySchema,
  REST_SOURCE_FIELD,
} from '@tm/shared';
import { ARTIFACT_LIMITS, toBase64 } from '../src/client.js';
import { mcpTools } from '../src/mcp.js';
import { crc32, fromBase64, isZip, zipFiles, zipPath } from '../src/zip.js';
import { mockFetch, testClient } from './helpers.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Read a zip back through its central directory: path → content. */
function unzip(zip: Uint8Array): Record<string, string> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const packed = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = text(zip.subarray(at + 46, at + 46 + nameLen));
    // The local header must agree with the directory: yauzl checks both.
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint16(local + 6, true) & 0x08).toBe(0); // no data descriptor
    expect(v.getUint32(local + 18, true)).toBe(packed);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = zip.subarray(start, start + packed);
    const bytes = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    expect([0, 8]).toContain(method);
    expect(bytes.length).toBe(size);
    expect(crc32(bytes)).toBe(crc);
    out[name] = text(bytes);
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}

const sentZip = async (sent: unknown): Promise<Record<string, string>> =>
  unzip(new Uint8Array(await (sent as Blob).arrayBuffer()));

const BUILD = { id: 'b1', files: 1, bytes: 10, message: null, warnings: [], has_source: false, current: true };

describe('the zip writer', () => {
  it('round-trips files, sorted, with deflate where it helps', async () => {
    const big = 'a'.repeat(5000);
    const zip = await zipFiles([
      { path: './z.txt', bytes: utf8('z') },
      { path: 'assets\\app.js', bytes: utf8(big) },
      { path: '/index.html', bytes: utf8('<h1>hi</h1>') },
    ]);
    expect(isZip(zip)).toBe(true);
    expect(Object.keys(unzip(zip))).toEqual(['assets/app.js', 'index.html', 'z.txt']);
    expect(unzip(zip)['assets/app.js']).toBe(big);
    // 5 kB of one letter: only a stored entry would be this large.
    expect(zip.length).toBeLessThan(2000);
  });

  it('stores when asked, and is deterministic', async () => {
    const files = [{ path: 'index.html', bytes: utf8('x'.repeat(100)) }];
    const a = await zipFiles(files, { compress: false });
    const b = await zipFiles(files, { compress: false });
    expect([...a]).toEqual([...b]);
    expect(unzip(a)['index.html']).toBe('x'.repeat(100));
  });

  it('refuses .., empty names and duplicates', async () => {
    expect(() => zipPath('../x')).toThrow(/\.\./);
    expect(() => zipPath('./')).toThrow(/Not a file path/);
    await expect(
      zipFiles([
        { path: 'a.txt', bytes: utf8('1') },
        { path: './a.txt', bytes: utf8('2') },
      ]),
    ).rejects.toThrow(/share the path/);
  });

  it('fromBase64 undoes toBase64', () => {
    for (const n of [0, 1, 2, 3, 4, 255, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    }
    expect(() => fromBase64('a*b')).toThrow(/base64/);
  });
});

describe('limits', () => {
  it('are the ones the server enforces', () => {
    expect(ARTIFACT_LIMITS.zipBytes).toBe(ARTIFACT_ZIP_MAX_BYTES);
    expect(ARTIFACT_LIMITS.buildBytes).toBe(ARTIFACT_BUILD_MAX_BYTES);
    expect(ARTIFACT_LIMITS.buildFiles).toBe(ARTIFACT_BUILD_MAX_FILES);
  });
});

describe('artifacts: the plain routes', () => {
  it('list unwraps the page', async () => {
    const f = mockFetch({ body: { data: [{ id: 'a1' }], next_cursor: null } });
    const out = await testClient(f).artifacts.list();
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts' });
    expect(out).toEqual([{ id: 'a1' }]);
  });

  it('get, create, update, delete', async () => {
    const f = mockFetch({ body: { id: 'a1' } });
    const tm = testClient(f);
    await tm.artifacts.get('a1');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1' });

    await tm.artifacts.create({ name: 'Sales', description: 'Q3', icon: '📈' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/artifacts', body: { name: 'Sales', description: 'Q3', icon: '📈' } });
    expect(f.last().headers['idempotency-key']).toBeTruthy();

    await tm.artifacts.update('a1', { readOnly: true, archived: false, description: null });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/artifacts/a1' });
    expect(f.last().body).toEqual({ read_only: true, archived: false, description: null });

    f.queue({ status: 204 });
    await tm.artifacts.update('a1', { name: 'x' });
    expect(await tm.artifacts.delete('a1')).toBeUndefined();
    expect(f.last()).toMatchObject({ method: 'DELETE', path: '/artifacts/a1' });
  });

  it('rollback and source', async () => {
    const f = mockFetch({ body: {} });
    const tm = testClient(f);
    await tm.artifacts.rollback('a1', 'b2');
    expect(f.last()).toMatchObject({ method: 'POST', path: '/artifacts/a1/builds/b2/current' });
    await tm.artifacts.source('a1');
    expect(f.last().url).toBe('http://tm.test/v1/artifacts/a1/source');
    await tm.artifacts.source('a1', 'b2');
    expect(f.last()).toMatchObject({ method: 'GET', path: '/artifacts/a1/source', query: { build: 'b2' } });
  });

  it('share takes exactly one of email or agent', async () => {
    const f = mockFetch({ body: { ok: true, outcome: 'granted' } });
    const tm = testClient(f);
    await tm.artifacts.share('a1', { email: 'p@example.com', role: 'viewer' });
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/access', body: { email: 'p@example.com', role: 'viewer' } });
    await tm.artifacts.share('a1', { agent: 'ag_0123456789abcdef', role: null });
    expect(f.last().body).toEqual({ agent: 'ag_0123456789abcdef', role: null });
    // The types refuse these two; a JS caller still gets the message.
    expect(() => tm.artifacts.share('a1', { role: 'viewer' } as never)).toThrow(/exactly one/);
    expect(() => tm.artifacts.share('a1', { email: 'a@b.c', agent: 'ag_x', role: 'viewer' } as never)).toThrow(/exactly one/);
  });

  it('share gives an agent build and data separately (§AA3)', async () => {
    const f = mockFetch({ body: { ok: true, outcome: 'granted' } });
    const tm = testClient(f);
    await tm.artifacts.share('a1', { agent: 'ag_0123456789abcdef', access: { build: false, data: 'read' } });
    expect(f.last()).toMatchObject({ method: 'PUT', path: '/artifacts/a1/access' });
    expect(f.last().body).toEqual({ agent: 'ag_0123456789abcdef', agent_access: { build: false, data: 'read' } });
    // The body is one the server's own schema accepts.
    expect(RestArtifactAccessBodySchema.safeParse(f.last().body).success).toBe(true);
    // The old role form still goes through unchanged.
    await tm.artifacts.share('a1', { agent: 'ag_0123456789abcdef', role: 'editor' });
    expect(f.last().body).toEqual({ agent: 'ag_0123456789abcdef', role: 'editor' });
    expect(() => tm.artifacts.share('a1', { email: 'a@b.c', access: { build: true, data: 'none' } } as never)).toThrow(/for an agent/);
    expect(() => tm.artifacts.share('a1', { agent: 'ag_x' } as never)).toThrow(/give role/);
  });
});

describe('artifacts.publish', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-sdk-artifact-'));
    await mkdir(join(dir, 'dist', 'assets'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.html'), '<script src="./assets/app.js"></script>');
    await writeFile(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'dist', '.DS_Store'), 'junk');
    await writeFile(join(dir, 'src', 'main.ts'), 'export {}');
    await writeFile(join(dir, 'package.json'), '{}');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await writeFile(join(dir, '.env.local'), 'SECRET=2');
    await writeFile(join(dir, '.env.example'), 'SECRET=');
    await writeFile(join(dir, 'big.bin'), new Uint8Array(2 * 1024 * 1024 + 1));
    await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    await writeFile(join(dir, '.git', 'HEAD'), 'ref');
    // A link back up the tree must not loop the walk.
    await symlink(dir, join(dir, 'src', 'loop')).catch(() => undefined);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('files in memory → one application/zip body', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    const build = await testClient(f).artifacts.publish(
      'a1',
      [
        { path: 'index.html', content: '<h1>hi</h1>' },
        { path: 'logo.bin', content: toBase64(Uint8Array.of(1, 2, 3)), encoding: 'base64' },
        { path: 'raw.txt', content: utf8('raw') },
      ],
      { message: 'first cut' },
    );
    expect(build.id).toBe('b1');
    const call = f.last();
    expect(call).toMatchObject({ method: 'POST', path: '/artifacts/a1/builds', query: { message: 'first cut' } });
    expect(call.headers['content-type']).toBe('application/zip');
    expect(call.headers['idempotency-key']).toBe('idem-1');
    const files = await sentZip(call.sent);
    expect(Object.keys(files)).toEqual(['index.html', 'logo.bin', 'raw.txt']);
    expect(files['index.html']).toBe('<h1>hi</h1>');
    expect(files['logo.bin']).toBe('\u0001\u0002\u0003');
  });

  it('a record of path → content works too', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    await testClient(f).artifacts.publish('a1', { 'index.html': 'x', 'a/b.js': 'y' });
    expect(await sentZip(f.last().sent)).toEqual({ 'a/b.js': 'y', 'index.html': 'x' });
    expect(f.last().query).toEqual({});
  });

  it('zip bytes go up unopened; anything else is refused', async () => {
    const zip = await zipFiles([{ path: 'index.html', bytes: utf8('z') }]);
    const f = mockFetch({ status: 201, body: BUILD });
    const tm = testClient(f);
    await tm.artifacts.publish('a1', zip);
    expect([...new Uint8Array(await (f.last().sent as Blob).arrayBuffer())]).toEqual([...zip]);
    await tm.artifacts.publish('a1', new Blob([zip as BlobPart]));
    expect(await sentZip(f.last().sent)).toEqual({ 'index.html': 'z' });
    await expect(tm.artifacts.publish('a1', utf8('<html>'))).rejects.toThrow(/not a zip/);
    expect(f.calls.length).toBe(2);
  });

  it('refuses a build with no index.html at its root, before any request', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    const tm = testClient(f);
    await expect(tm.artifacts.publish('a1', [{ path: 'app.js', content: 'x' }])).rejects.toThrow(/no index\.html/);
    await expect(tm.artifacts.publish('a1', dir)).rejects.toThrow(/no index\.html/);
    await expect(tm.artifacts.publish('a1', [])).rejects.toThrow(/no files/);
    await expect(tm.artifacts.publish('a1', join(dir, 'nope'))).rejects.toThrow(/cannot read/);
    // A single top folder is fine: the server strips it.
    await tm.artifacts.publish('a1', [{ path: 'dist/index.html', content: 'x' }]);
    expect(f.calls.length).toBe(1);
  });

  it('refuses an oversized build with code too_large, before any request', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    const files = Array.from({ length: ARTIFACT_LIMITS.buildFiles + 1 }, (_, i) => ({ path: i ? `f${i}.txt` : 'index.html', content: '' }));
    await expect(testClient(f).artifacts.publish('a1', files)).rejects.toMatchObject({ name: 'TmError', code: 'too_large', status: 0 });
    expect(f.calls.length).toBe(0);
  });

  it('a directory is walked and zipped', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    await testClient(f).artifacts.publish('a1', join(dir, 'dist') + '/');
    expect(await sentZip(f.last().sent)).toEqual({
      'assets/app.js': 'console.log(1)',
      'index.html': '<script src="./assets/app.js"></script>',
    });
  });

  it('with a source folder: multipart, and the source leaves out what is not source', async () => {
    const f = mockFetch({ status: 201, body: BUILD });
    await testClient(f).artifacts.publish('a1', join(dir, 'dist'), { source: dir, message: 'm' });
    const call = f.last();
    expect(call.query).toEqual({ message: 'm', source: '1' });
    // fetch writes the multipart content-type itself, with the boundary.
    expect(call.headers['content-type']).toBeUndefined();
    const form = call.sent as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(Object.keys(await sentZip(form.get(REST_BUILD_FIELD)))).toEqual(['assets/app.js', 'index.html']);
    expect(Object.keys(await sentZip(form.get(REST_SOURCE_FIELD)))).toEqual(['.env.example', 'package.json', 'src/main.ts']);
  });

  it('a build folder with an unusual name is still left out of its own source', async () => {
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'index.html'), 'o');
    const f = mockFetch({ status: 201, body: BUILD });
    await testClient(f).artifacts.publish('a1', join(dir, 'out'), { source: dir });
    const source = await sentZip((f.last().sent as FormData).get(REST_SOURCE_FIELD));
    expect(Object.keys(source).some((p) => p.startsWith('out/'))).toBe(false);
    await rm(join(dir, 'out'), { recursive: true });
  });

  it('source as zip bytes is sent as it is', async () => {
    const src = await zipFiles([{ path: 'main.ts', bytes: utf8('s') }]);
    const f = mockFetch({ status: 201, body: BUILD });
    const tm = testClient(f);
    await tm.artifacts.publish('a1', { 'index.html': 'x' }, { source: src });
    expect(await sentZip((f.last().sent as FormData).get(REST_SOURCE_FIELD))).toEqual({ 'main.ts': 's' });
    await expect(tm.artifacts.publish('a1', { 'index.html': 'x' }, { source: utf8('nope') })).rejects.toThrow(/source/);
  });

  it('a retry sends the same body under the same Idempotency-Key', async () => {
    const f = mockFetch({ status: 503, body: {} }, { status: 201, body: BUILD });
    await testClient(f, { retry: 1 }).artifacts.publish('a1', { 'index.html': 'x' });
    expect(f.calls.length).toBe(2);
    expect(f.calls[0]!.headers['idempotency-key']).toBe(f.calls[1]!.headers['idempotency-key']);
    expect(await sentZip(f.calls[1]!.sent)).toEqual({ 'index.html': 'x' });
  });
});

describe('the artifact MCP tools', () => {
  it('artifact_publish zips the inline files and answers with the build and its url', async () => {
    const f = mockFetch({ status: 201, body: BUILD }, { body: { id: 'a1', url: 'http://tm.test/x/a1' } });
    const tools = await mcpTools(testClient(f), { scopes: ['artifacts:write'] });
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'artifact_create',
        'artifact_data_batch',
        'artifact_data_get',
        'artifact_data_list',
        'artifact_data_set',
        'artifact_get',
        'artifact_list',
        'artifact_publish',
        'artifact_rollback',
        'artifact_share',
        'artifact_source',
        'whoami',
      ].sort(),
    );
    const publish = tools.find((t) => t.name === 'artifact_publish')!;
    const out = await publish.handler({ id: 'a1', files: [{ path: 'index.html', content: 'aGk=', encoding: 'base64' }], message: 'm' });
    expect(out).toMatchObject({ id: 'b1', url: 'http://tm.test/x/a1' });
    expect(await sentZip(f.calls[0]!.sent)).toEqual({ 'index.html': 'hi' });
  });

  it('a read-only credential sees only the read tools', async () => {
    const tools = await mcpTools(testClient(mockFetch()), { scopes: ['artifacts:read'] });
    expect(tools.map((t) => t.name).sort()).toEqual(['artifact_data_get', 'artifact_data_list', 'artifact_get', 'artifact_list', 'artifact_source', 'whoami']);
  });

  it('artifact_share passes null through to remove', async () => {
    const f = mockFetch({ body: { ok: true, outcome: 'removed' } });
    const tools = await mcpTools(testClient(f), { scopes: ['artifacts:write'] });
    await tools.find((t) => t.name === 'artifact_share')!.handler({ id: 'a1', email: 'p@example.com', role: null });
    expect(f.last().body).toEqual({ email: 'p@example.com', role: null });
  });

  it('artifact_share sends agent_access for an agent', async () => {
    const f = mockFetch({ body: { ok: true, outcome: 'granted' } });
    const tools = await mcpTools(testClient(f), { scopes: ['artifacts:write'] });
    await tools.find((t) => t.name === 'artifact_share')!.handler({ id: 'a1', agent: 'ag_0123456789abcdef', agent_access: { build: true, data: 'none' } });
    expect(f.last().body).toEqual({ agent: 'ag_0123456789abcdef', agent_access: { build: true, data: 'none' } });
  });
});
