/**
 * THE E2E STACK ON A VM (TM_E2E_PLATFORM=vm): instead of the emulators, the
 * one-port VM server (backend/lib/server.js) runs INSIDE the test process —
 * so admin() reads and writes the very SQLite files, JSON tree and identity
 * store the server uses, and the server's change feed sees them at once.
 *
 *   TM_PLATFORM=vm pnpm --filter @tm/frontend build     the VM build of the SPA
 *   pnpm e2e:vm                                         this stack + the ui suites
 *
 * One server per Playwright worker (workers: 1); its data lives in a fresh
 * temp directory per run (TM_E2E_DATA_DIR keeps it across worker restarts).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** TM_E2E_PLATFORM=icebase: the same, with TaskManager inside the IceBase server (`icebase serve`). */
export const ICEBASE = process.env.TM_E2E_PLATFORM === 'icebase';
export const VM = process.env.TM_E2E_PLATFORM === 'vm' || ICEBASE;
export const VM_PORT = Number(process.env.TM_E2E_VM_PORT || 5280);
export const VM_URL = `http://127.0.0.1:${VM_PORT}`;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the backend's ports, loaded from its build
type Any = any;
let ports: { db: Any; identity: Any; rtdb: Any } | undefined;

async function bootIcebase(): Promise<void> {
  // `icebase serve` in its own process (as in production); this process reaches the same data over
  // HTTP with IceBase's admin API (the backend's own db / identity / rtdb, TM_PLATFORM=icebase).
  const data = process.env.TM_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'tm-e2e-icebase-'));
  const adminToken = randomBytes(24).toString('base64url');
  const env = {
    ...process.env,
    TM_PLATFORM: 'icebase',
    TM_DEV: '1', // dev outbox for mail and push, as under the emulators
    TM_DATA_DIR: data,
    APP_URL: VM_URL,
    API_URL: VM_URL,
    ICEBASE_PUBLIC_URL: VM_URL,
    ICEBASE_ADMIN_TOKEN: adminToken,
    TM_ARTIFACT_ORIGIN: process.env.TM_ARTIFACT_ORIGIN || `http://localhost:${VM_PORT}`,
    TM_DEV_WEBHOOK_SINK: process.env.TM_DEV_WEBHOOK_SINK || 'http://127.0.0.1:5199',
    ICEBASE_LOG_ERRORS: '1',
    ...(process.env.ICEBASE_LOG_REQUESTS ? { ICEBASE_LOG_REQUESTS: '1' } : {}),
  };
  const cli = createRequire(join(ROOT, 'backend', 'package.json')).resolve('@panth977/icebase-cli/cli');
  const child = spawn(process.execPath, [cli, 'serve', '--port', String(VM_PORT), '--host', '127.0.0.1', '--data', join(data, 'icebase')], { cwd: join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (b: Buffer) => (process.env.ICEBASE_LOG_REQUESTS || /failed|threw|gave up|Error/.test(String(b))) && process.stderr.write(b);
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  process.once('exit', () => child.kill());
  for (let i = 0; i < 600 && !(await fetch(`${VM_URL}/config.json`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  Object.assign(process.env, { TM_PLATFORM: 'icebase', TM_DEV: '1', TM_DATA_DIR: data, APP_URL: VM_URL, ICEBASE_EMULATOR_HOST: `127.0.0.1:${VM_PORT}`, ICEBASE_ADMIN_TOKEN: adminToken });
  const lib = (p: string) => import(join(ROOT, 'backend', 'lib', p));
  const [{ db }, { identity }, { realtimeDb }] = await Promise.all([lib('db/index.js'), lib('identity/index.js'), lib('rtdb/index.js')]);
  ports = { db: db(), identity: identity(), rtdb: realtimeDb() };
}

export async function bootVm(): Promise<void> {
  if (ports) return;
  if (ICEBASE) return bootIcebase();
  process.env.TM_PLATFORM = 'vm';
  process.env.TM_DEV = '1'; // dev outbox for mail and push, as under the emulators
  process.env.TM_DATA_DIR ||= process.env.TM_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'tm-e2e-vm-'));
  process.env.APP_URL = VM_URL;
  process.env.API_URL = VM_URL;
  // Artifacts on their own origin, on the same port: another host name for it.
  process.env.TM_ARTIFACT_ORIGIN ||= `http://localhost:${VM_PORT}`;
  // Webhooks to https://*.webhook.test go to the e2e receiver (as dev.mjs sets it).
  process.env.TM_DEV_WEBHOOK_SINK ||= 'http://127.0.0.1:5199';
  process.env.TM_WEB_DIR ||= join(ROOT, 'frontend', 'build');
  process.env.PORT = String(VM_PORT);
  const lib = (p: string) => import(join(ROOT, 'backend', 'lib', p));
  const [{ startServer }, { db }, { identity }, { realtimeDb }] = await Promise.all([
    lib('server.js'),
    lib('db/index.js'),
    lib('identity/index.js'),
    lib('rtdb/index.js'),
  ]);
  await startServer(VM_PORT);
  ports = { db: db(), identity: identity(), rtdb: realtimeDb() };
}

export function vmAdmin(): { db: Any; auth: Any; rtdb: Any } {
  if (!ports) throw new Error('bootVm() first');
  return { db: ports.db, auth: ports.identity, rtdb: ports.rtdb };
}
