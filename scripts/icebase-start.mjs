// The IceBase image's entry: what the VM server decides at start, done once on a copy of the web
// build, then `icebase serve`.
//   - branding (backend/src/runtime/brand.ts): TM_APP_NAME, the logo in /branding → the HTML, the
//     manifest and every icon
//   - /_app/env.js: the SPA's $env/dynamic/public (TM_ADMIN_EMAIL, the app's name, any PUBLIC_*),
//     so one image serves any deploy
// The copy goes to TM_WEB_DIR (default /tmp/tm-web), which backend/icebase.config.ts serves.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'frontend', 'build');
const out = process.env.TM_WEB_DIR || '/tmp/tm-web';

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const { loadBrand } = await import(pathToFileURL(join(root, 'backend', 'lib', 'runtime', 'brand.js')).href);
const brand = await loadBrand();
let rewritten = 0;
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.(html|webmanifest|json)$/.test(n)) {
      const b = brand.rewrite(f, readFileSync(f));
      if (b) {
        writeFileSync(f, b);
        rewritten++;
      }
    }
  }
};
walk(out);
for (const [path, file] of brand.files) {
  const f = join(out, path);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, file.body);
}

const publicEnv = {
  PUBLIC_USE_EMULATORS: 'false',
  PUBLIC_FIREBASE_PROJECT_ID: 'taskmanager',
  PUBLIC_FIREBASE_API_KEY: 'icebase',
  PUBLIC_FCM_VAPID_KEY: 'from-server',
  ...(process.env.TM_ADMIN_EMAIL ? { PUBLIC_TM_ADMIN_EMAIL: process.env.TM_ADMIN_EMAIL } : {}),
  ...brand.publicEnv,
  ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('PUBLIC_') && typeof v === 'string')),
};
mkdirSync(join(out, '_app'), { recursive: true });
writeFileSync(join(out, '_app', 'env.js'), `export const env=${JSON.stringify(publicEnv)}`);
console.log(`[start] web app in ${out}: ${rewritten} file(s) renamed, ${brand.files.size} icon(s)${brand.logo ? ' from the logo' : ''}`);

process.env.TM_WEB_DIR = out;
process.env.ICEBASE_PUBLIC_URL ||= process.env.APP_URL;
process.argv = [process.argv[0], process.argv[1], 'serve', ...process.argv.slice(2)];
await import(pathToFileURL(join(root, 'scripts', 'icebase.mjs')).href);
