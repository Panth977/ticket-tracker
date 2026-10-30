/**
 * THE E2E STACK ON THE ICEBASE SERVER (TM_ICEBASE=emulator): instead of Firebase's emulators,
 * `icebase serve` (backend/icebase.config.ts) runs as a child process on one port — the web app
 * (the emulator build in frontend/build), the functions and every service — and this process
 * reaches the same data with IceBase's admin API (the backend's own db / identity / rtdb).
 *
 *   TM_ICEBASE=emulator pnpm --filter @tm/frontend build     the emulator build of the SPA
 *   pnpm e2e:icebase                                        this stack + every suite
 *
 * One server per Playwright worker (workers: 1); its data lives in a fresh temp directory per
 * run (TM_E2E_DATA_DIR keeps it across worker restarts).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICEBASE = process.env.TM_ICEBASE === 'emulator';
export const ICEBASE_PORT = Number(process.env.TM_E2E_PORT || 5280);
export const ICEBASE_URL = `http://127.0.0.1:${ICEBASE_PORT}`;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the backend's ports, loaded from its build
type Any = any;
let ports: { db: Any; identity: Any; rtdb: Any } | undefined;

export async function bootIcebase(): Promise<void> {
  if (ports) return;
  // `icebase serve` in its own process (as in production); this process reaches the same data over
  // HTTP with IceBase's admin API (the backend’s own db / identity / rtdb).
  const data = process.env.TM_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'tm-e2e-icebase-'));
  const adminToken = randomBytes(24).toString('base64url');
  const env = {
    ...process.env,
    TM_ICEBASE: 'emulator',
    TM_DEV: '1', // dev outbox for mail and push, as under the emulators
    TM_DATA_DIR: data,
    APP_URL: ICEBASE_URL,
    API_URL: ICEBASE_URL,
    ICEBASE_PUBLIC_URL: ICEBASE_URL,
    ICEBASE_ADMIN_TOKEN: adminToken,
    TM_ARTIFACT_ORIGIN: process.env.TM_ARTIFACT_ORIGIN || `http://localhost:${ICEBASE_PORT}`,
    TM_DEV_WEBHOOK_SINK: process.env.TM_DEV_WEBHOOK_SINK || 'http://127.0.0.1:5199',
    ICEBASE_LOG_ERRORS: '1',
    ...(process.env.ICEBASE_LOG_REQUESTS ? { ICEBASE_LOG_REQUESTS: '1' } : {}),
  };
  const cli = createRequire(join(ROOT, 'backend', 'package.json')).resolve('@panth977/icebase-cli/cli');
  const child = spawn(process.execPath, [cli, 'serve', '--port', String(ICEBASE_PORT), '--host', '127.0.0.1', '--data', join(data, 'icebase')], { cwd: join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (b: Buffer) => (process.env.ICEBASE_LOG_REQUESTS || /failed|threw|gave up|Error/.test(String(b))) && process.stderr.write(b);
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  process.once('exit', () => child.kill());
  for (let i = 0; i < 600 && !(await fetch(`${ICEBASE_URL}/config.json`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  Object.assign(process.env, { TM_ICEBASE: 'emulator', TM_DEV: '1', TM_DATA_DIR: data, APP_URL: ICEBASE_URL, ICEBASE_EMULATOR_HOST: `127.0.0.1:${ICEBASE_PORT}`, ICEBASE_ADMIN_TOKEN: adminToken });
  const lib = (p: string) => import(join(ROOT, 'backend', 'lib', p));
  const [{ db }, { identity }, { realtimeDb }] = await Promise.all([lib('db/index.js'), lib('identity/index.js'), lib('rtdb/index.js')]);
  ports = { db: db(), identity: identity(), rtdb: realtimeDb() };
}

export function icebaseAdmin(): { db: Any; auth: Any; rtdb: Any } {
  if (!ports) throw new Error('bootIcebase() first');
  return { db: ports.db, auth: ports.identity, rtdb: ports.rtdb };
}
