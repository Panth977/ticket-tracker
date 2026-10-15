/**
 * Branding a VM deploy (runtime/brand.ts): TM_APP_NAME and a logo mounted in
 * TM_BRAND_DIR rename the HTML and the manifest and replace every icon.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const dir = mkdtempSync(join(tmpdir(), 'tm-brand-'));
const web = join(dir, 'web');
const brandDir = join(dir, 'branding');
mkdirSync(join(web, 'icons'), { recursive: true });
mkdirSync(brandDir);
writeFileSync(
  join(web, 'index.html'),
  '<!doctype html><title>TaskManager</title><meta name="application-name" content="TaskManager" /><meta name="apple-mobile-web-app-title" content="Tasks" />',
);
writeFileSync(
  join(web, 'offline.html'),
  '<title>Offline · TaskManager</title><p>TaskManager hasn’t finished',
);
writeFileSync(
  join(web, 'manifest.webmanifest'),
  JSON.stringify({
    name: 'TaskManager',
    short_name: 'Tasks',
    icons: [{ src: '/icons/icon-192.png' }],
  }),
);
writeFileSync(join(web, 'favicon.ico'), 'built-in');
writeFileSync(join(web, 'icons', 'icon-192.png'), 'built-in');
// A 300×200 red logo: not square, so "contain" has to pad it.
writeFileSync(
  join(brandDir, 'logo.png'),
  await sharp({ create: { width: 300, height: 200, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer(),
);
Object.assign(process.env, {
  TM_PLATFORM: 'vm',
  TM_DEV: '1',
  TM_DATA_DIR: join(dir, 'data'),
  TM_WEB_DIR: web,
  TM_QUEUE: 'memory',
  APP_URL: 'http://127.0.0.1',
  TM_APP_NAME: 'Oizom Tasks',
  TM_BRAND_DIR: brandDir,
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { startServer } = await import('../../src/server.js');
const brand = await import('../../src/runtime/brand.js');

let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';
beforeAll(async () => {
  srv = await startServer(0);
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('branding helpers', () => {
  it('names: short name from the first word when long, HTML escaped', () => {
    expect(brand.shortNameOf('Acme')).toBe('Acme');
    expect(brand.shortNameOf('Oizom Ticket Tracker')).toBe('Oizom');
    const html = brand.rewriteHtml(
      '<title>Sign in · TaskManager</title><meta name="application-name" content="TaskManager" />',
      'A&B <Tasks>',
      'A&B',
    );
    expect(html).toContain('<title>Sign in · A&amp;B &lt;Tasks&gt;</title>');
    expect(html).toContain('content="A&amp;B &lt;Tasks&gt;"');
  });

  it('an .ico of PNG entries has a valid directory', () => {
    const png = Buffer.from([1, 2, 3]);
    const ico = brand.icoOf([
      { size: 16, png },
      { size: 32, png },
    ]);
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // two images
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32); // first image after the directory
    expect(ico.length).toBe(6 + 32 + 6);
  });

  it('no logo, no name → nothing changes', async () => {
    const b = await brand.loadBrand({ TM_BRAND_DIR: join(dir, 'none') });
    expect(b.files.size).toBe(0);
    expect(b.publicEnv).toEqual({});
    expect(b.rewrite('index.html', Buffer.from('<title>TaskManager</title>'))).toBeNull();
  });

  it('a missing TM_LOGO falls back to the built-in icons', async () => {
    const b = await brand.loadBrand({ TM_LOGO: join(dir, 'nope.png') });
    expect(b.logo).toBeNull();
  });
});

describe('VM server, branded', () => {
  it('the HTML and the manifest carry the name', async () => {
    const page = await (await fetch(`${base}/b/ENG`)).text();
    expect(page).toContain('<title>Oizom Tasks</title>');
    expect(page).toContain('name="application-name" content="Oizom Tasks"');
    expect(page).toContain('name="apple-mobile-web-app-title" content="Oizom Tasks"');
    const offline = await (await fetch(`${base}/offline.html`)).text();
    expect(offline).toContain('Offline · Oizom Tasks');
    expect(offline).toContain('Oizom Tasks hasn’t finished');
    const m = await (await fetch(`${base}/manifest.webmanifest`)).json();
    expect(m).toMatchObject({ name: 'Oizom Tasks', short_name: 'Oizom Tasks' });
  });

  it('the SPA gets PUBLIC_APP_NAME', async () => {
    expect(await (await fetch(`${base}/_app/env.js`)).text()).toContain(
      '"PUBLIC_APP_NAME":"Oizom Tasks"',
    );
  });

  it('every icon is made from the logo, revalidated by ETag', async () => {
    for (const [path, size] of [
      ['/icons/icon-192.png', 192],
      ['/icons/icon-512.png', 512],
      ['/icons/icon-maskable-512.png', 512],
      ['/icons/apple-touch-icon-180.png', 180],
      ['/favicon-96.png', 96],
    ] as const) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect([path, meta.width, meta.height]).toEqual([path, size, size]);
    }
    // contain: the 3:2 logo is padded with transparency; the Apple icon is opaque.
    const any = await (await fetch(`${base}/icons/icon-192.png`)).arrayBuffer();
    const corner = await sharp(Buffer.from(any))
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(corner[3]).toBe(0);
    const apple = await (await fetch(`${base}/icons/apple-touch-icon-180.png`)).arrayBuffer();
    expect((await sharp(Buffer.from(apple)).stats()).isOpaque).toBe(true);

    const ico = await fetch(`${base}/favicon.ico`);
    const buf = Buffer.from(await ico.arrayBuffer());
    expect(buf.readUInt16LE(4)).toBe(3);
    const svg = await (await fetch(`${base}/favicon.svg`)).text();
    expect(svg).toContain('data:image/png;base64,');

    const etag = ico.headers.get('etag')!;
    expect(
      (await fetch(`${base}/favicon.ico`, { headers: { 'if-none-match': etag } })).status,
    ).toBe(304);
  });
});
