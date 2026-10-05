import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { defaultClientConditions, defaultServerConditions, type Plugin } from 'vite';

// Every PWA icon is generated from frontend/static/icons/source.svg. Running the
// generator at the start of each production build is what makes a stale icon
// impossible: edit the mark, `pnpm build`, and all six PNGs follow (agents.html § S).
// It runs in a child process so sharp stays a root devDependency, out of the SPA's.
const GEN_ICONS = fileURLToPath(new URL('../scripts/gen-icons.mjs', import.meta.url));
// `vite build` runs twice here (client, then SSR); once is enough.
let generated = false;
const icons: Plugin = {
  name: 'tm-gen-icons',
  apply: 'build',
  buildStart() {
    if (generated) return;
    generated = true;
    const r = spawnSync(process.execPath, [GEN_ICONS], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('gen-icons.mjs failed — the PWA icons are not up to date');
  },
};

// window.BackendDriver (artifacts.html §E1) is served from static/backend-driver
// and committed there so `vite dev` has it; rebuilding it with every production
// build is what keeps the committed copy from drifting behind driver/src or the
// protocol in @tm/shared. A child process, for the same reason as the icons:
// esbuild stays the driver package's dependency, not the SPA's.
const BUILD_DRIVER = fileURLToPath(new URL('../driver/build.mjs', import.meta.url));
let driverBuilt = false;
const driver: Plugin = {
  name: 'tm-backend-driver',
  apply: 'build',
  buildStart() {
    if (driverBuilt) return;
    driverBuilt = true;
    const r = spawnSync(process.execPath, [BUILD_DRIVER, '--quiet'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('driver/build.mjs failed — static/backend-driver is stale');
  },
};

// In dev, requests the SPA makes to the backend "doors" are forwarded to the
// Functions emulator's `api` function (same paths firebase.json rewrites in prod).
// Ports are this project's dedicated emulator block (firebase.json).
const FUNCTIONS_PORT = process.env.PUBLIC_EMULATOR_FUNCTIONS_PORT || '5101';
const API = `http://127.0.0.1:${FUNCTIONS_PORT}/demo-taskmanager/us-central1/api`;
const proxied = [
  '/api',
  '/v1',
  '/mcp',
  '/oauth',
  '/hooks',
  '/ics',
  '/integrations',
  '/.well-known',
];
// /oauth/consent is the SPA's consent screen, not an api route (same as the
// firebase.json rewrite that sends it to index.html).
const bypass = (req: { url?: string }) =>
  req.url?.startsWith('/oauth/consent') && !req.url.startsWith('/oauth/consent/')
    ? req.url
    : undefined;

export default defineConfig({
  plugins: [icons, driver, tailwindcss(), sveltekit()],
  // "@tm/source" resolves @tm/shared to its TypeScript source: live HMR, no prebuild.
  resolve: { conditions: ['@tm/source', ...defaultClientConditions] },
  ssr: {
    resolve: {
      conditions: ['@tm/source', ...defaultServerConditions],
      externalConditions: ['@tm/source', ...defaultServerConditions],
    },
  },
  server: {
    // 5190 is part of this project's port block (5173/5174 are often held by
    // other local projects). E2E and APP_URL assume it, hence strictPort.
    port: Number(process.env.TM_WEB_PORT || 5190),
    strictPort: true,
    host: '127.0.0.1',
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: API, changeOrigin: true, bypass }])),
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
