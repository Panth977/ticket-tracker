/**
 * BRANDING a VM deploy (agents.html § S, "Branding") — one image, any name and
 * logo, decided when the server starts:
 *
 *   TM_APP_NAME        the app's name: the tab title, the PWA's name, the
 *                      SPA's own name for itself (PUBLIC_APP_NAME), e-mails.
 *   TM_APP_SHORT_NAME  the home-screen label (default: the name, if it is
 *                      short, else its first word).
 *   TM_LOGO            a logo file (SVG, PNG, WebP or JPEG). Default: the
 *                      first of logo.svg / .png / .webp / .jpg / .jpeg in
 *                      TM_BRAND_DIR (default /branding) — so a deploy mounts
 *                      `-v ./logo.png:/branding/logo.png:ro` and restarts.
 *   TM_LOGO_BG         the colour behind the logo where an icon must be
 *                      opaque (Android maskable, Apple touch). Default #ffffff.
 *
 * With a logo, every icon the build ships is made from it at start, in
 * memory, and served in place of the build's file: favicon.svg / .ico /
 * -96.png, icons/icon-{192,256,384,512}.png, icons/icon-maskable-512.png and
 * icons/apple-touch-icon-180.png. They go out `no-cache` with an ETag, so a
 * new logo shows after a restart. With a name, the static HTML (title,
 * application-name, apple-mobile-web-app-title, the offline page) and the
 * manifest are rewritten as they are served. Nothing set → the build as is.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** The name this deploy goes by (backend strings read it too). */
export function appName(): string {
  return process.env.TM_APP_NAME?.trim() || 'TaskManager';
}

export interface BrandFile {
  body: Buffer;
  type: string;
  etag: string;
}

export interface Brand {
  /** url path → a generated icon that replaces the build's file. */
  files: Map<string, BrandFile>;
  /** Rewrite a build file as served (HTML, the manifest), or null to send it untouched. */
  rewrite(file: string, raw: Buffer): Buffer | null;
  /** What the SPA's $env/dynamic/public gets on top. */
  publicEnv: Record<string, string>;
  logo: string | null;
}

const LOGO_EXT = ['.svg', '.png', '.webp', '.jpg', '.jpeg'];

/** The logo file to use, or null. */
export function findLogo(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TM_LOGO?.trim()) {
    const p = env.TM_LOGO.trim();
    if (!existsSync(p)) {
      console.warn(`[brand] TM_LOGO=${p} does not exist — using the built-in icons`);
      return null;
    }
    return p;
  }
  const dir = env.TM_BRAND_DIR?.trim() || '/branding';
  for (const ext of LOGO_EXT) {
    const p = join(dir, `logo${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function shortNameOf(name: string): string {
  return name.length <= 12 ? name : (name.split(/\s+/)[0] ?? name).slice(0, 12);
}

const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The HTML of the build with this deploy's name in it. */
export function rewriteHtml(html: string, name: string, short: string): string {
  const n = escHtml(name);
  return html
    .replace(/(<title>[^<]*?)TaskManager(<\/title>)/g, `$1${n}$2`)
    .replace(/(<meta name="application-name" content=")[^"]*(")/, `$1${n}$2`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${escHtml(short)}$2`)
    .replace(/TaskManager hasn’t/g, `${n} hasn’t`);
}

export function rewriteManifest(json: string, name: string, short: string): string {
  const m = JSON.parse(json) as Record<string, unknown>;
  m.name = name;
  m.short_name = short;
  return JSON.stringify(m, null, 2);
}

/** An .ico holding PNG images (Vista+ / every current browser reads PNG entries). */
export function icoOf(pngs: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.png)]);
}

/** Every icon the build ships, made from one logo. */
export async function iconsFrom(
  logo: Buffer,
  isSvg: boolean,
  bg: string,
): Promise<Map<string, Buffer>> {
  // Loaded only when a logo is set: sharp is native and large.
  const sharp = (await import('sharp')).default;
  const src = () => sharp(logo, isSvg ? { density: 384 } : {});
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  /** The logo contained in a transparent square. */
  const plain = (size: number) =>
    src().resize(size, size, { fit: 'contain', background: clear }).png().toBuffer();
  /** The logo at `scale` of an opaque `bg` square (iOS and Android masks crop the edge). */
  const onTile = async (size: number, scale: number) => {
    const inner = Math.round(size * scale);
    const mark = await src()
      .resize(inner, inner, { fit: 'contain', background: clear })
      .png()
      .toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
      .composite([{ input: mark, gravity: 'center' }])
      .flatten({ background: bg })
      .png()
      .toBuffer();
  };
  const out = new Map<string, Buffer>();
  for (const s of [192, 256, 384, 512]) out.set(`/icons/icon-${s}.png`, await plain(s));
  out.set('/icons/icon-maskable-512.png', await onTile(512, 0.6));
  out.set('/icons/apple-touch-icon-180.png', await onTile(180, 0.8));
  out.set('/favicon-96.png', await plain(96));
  out.set(
    '/favicon.ico',
    icoOf([
      { size: 16, png: await plain(16) },
      { size: 32, png: await plain(32) },
      { size: 48, png: await plain(48) },
    ]),
  );
  out.set(
    '/favicon.svg',
    isSvg
      ? logo
      : Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><image width="96" height="96" href="data:image/png;base64,${out.get('/favicon-96.png')!.toString('base64')}"/></svg>`,
        ),
  );
  return out;
}

const TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Read the environment and the logo once, at start. */
export async function loadBrand(env: NodeJS.ProcessEnv = process.env): Promise<Brand> {
  const named = env.TM_APP_NAME?.trim() || null;
  const name = named ?? 'TaskManager';
  const short = env.TM_APP_SHORT_NAME?.trim() || (named ? shortNameOf(named) : 'Tasks');
  const logo = findLogo(env);
  const files = new Map<string, BrandFile>();
  if (logo) {
    try {
      const raw = readFileSync(logo);
      const icons = await iconsFrom(
        raw,
        extname(logo).toLowerCase() === '.svg',
        env.TM_LOGO_BG?.trim() || '#ffffff',
      );
      for (const [path, body] of icons)
        files.set(path, {
          body,
          type: TYPE[extname(path)] ?? 'application/octet-stream',
          etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
        });
      console.info(`[brand] icons made from ${logo}`);
    } catch (err) {
      console.warn(
        `[brand] could not use ${logo} (${(err as Error).message}) — using the built-in icons`,
      );
      files.clear();
    }
  }
  const named_ = named !== null || env.TM_APP_SHORT_NAME?.trim();
  return {
    files,
    logo: files.size ? logo : null,
    publicEnv: named ? { PUBLIC_APP_NAME: named } : {},
    rewrite(file, raw) {
      if (!named_) return null;
      if (file.endsWith('.html'))
        return Buffer.from(rewriteHtml(raw.toString('utf8'), name, short));
      if (basename(file) === 'manifest.webmanifest')
        return Buffer.from(rewriteManifest(raw.toString('utf8'), name, short));
      return null;
    },
  };
}
