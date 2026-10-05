/**
 * ARTIFACTS over the SDK (docs/plan/artifacts.html §C): an ACCOUNT token
 * publishes a real folder from disk through the built @tm/sdk, a second build
 * rolls forward and back, and the published files are what the capability URL
 * serves. A token without the artifact scopes gets nothing.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SCOPE_PRESETS } from '@tm/shared';
import { API_URL, call, newPerson } from '../support/stack.js';

test('publish a folder with the SDK, roll back, share; scopes gate it', async () => {
  const { createClient } = (await import('../../../sdk/dist/sdk.js' as string)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the built SDK, imported untyped
    createClient: (o: { token: string; baseUrl: string }) => any;
  };
  const owner = await newPerson('Sdk');
  const friend = await newPerson('Friend');
  const { key: token } = await call(owner, 'apiKeyCreate', {
    name: 'artifacts',
    kind: 'account',
    scopes: ['artifacts:read', 'artifacts:write'],
  });
  const tm = createClient({ token, baseUrl: API_URL });

  const dir = mkdtempSync(join(tmpdir(), 'tm-art-'));
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  writeFileSync(
    join(dir, 'dist', 'index.html'),
    '<h1>one</h1><script src="./assets/a.js"></script>',
  );
  writeFileSync(join(dir, 'dist', 'assets', 'a.js'), 'console.log("a")');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  writeFileSync(join(dir, '.env'), 'SECRET=1');

  const art = await tm.artifacts.create({ name: 'From the SDK' });
  expect(art.url).toContain(`/x/${art.id}`);
  const b1 = await tm.artifacts.publish(art.id, join(dir, 'dist'), { source: dir, message: 'one' });
  expect(b1.files).toBe(2);
  expect(b1.has_source).toBe(true);
  expect(b1.warnings).toEqual([]);

  const open1 = await call(owner, 'artifactOpen', { artifactId: art.id });
  expect(await (await fetch(open1.contentUrl)).text()).toContain('<h1>one</h1>');
  const js = await fetch(`${open1.contentBase}assets/a.js`);
  expect(js.status).toBe(200);
  expect(js.headers.get('content-type')).toContain('javascript');

  const b2 = await tm.artifacts.publish(
    art.id,
    { 'index.html': '<h1>two</h1>' },
    { message: 'two' },
  );
  const open2 = await call(owner, 'artifactOpen', { artifactId: art.id });
  expect(open2.buildId).toBe(b2.id);
  expect(await (await fetch(open2.contentUrl)).text()).toContain('<h1>two</h1>');

  await tm.artifacts.rollback(art.id, b1.id);
  const detail = await tm.artifacts.get(art.id);
  expect(detail.current_build).toBe(b1.id);
  expect(detail.builds.map((b: { message: string }) => b.message)).toEqual(['two', 'one']);

  const src = await tm.artifacts.source(art.id);
  expect((await fetch(src.url)).status).toBe(200);

  expect((await tm.artifacts.share(art.id, { email: friend.email, role: 'viewer' })).outcome).toBe(
    'granted',
  );
  expect((await call(friend, 'artifactOpen', { artifactId: art.id })).role).toBe('viewer');
  expect((await tm.artifacts.list()).map((a: { id: string }) => a.id)).toContain(art.id);

  // a token without the artifact scopes reaches none of it
  const { key: plain } = await call(owner, 'apiKeyCreate', {
    name: 'no-artifacts',
    kind: 'account',
    scopes: [...SCOPE_PRESETS.readOnly],
  });
  const other = createClient({ token: plain, baseUrl: API_URL });
  await expect(other.artifacts.list()).rejects.toThrow();
  await expect(other.artifacts.publish(art.id, { 'index.html': 'x' })).rejects.toThrow();
});
