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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VM = process.env.TM_E2E_PLATFORM === 'vm';
export const VM_PORT = Number(process.env.TM_E2E_VM_PORT || 5280);
export const VM_URL = `http://127.0.0.1:${VM_PORT}`;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the backend's ports, loaded from its build
type Any = any;
let ports: { db: Any; identity: Any; rtdb: Any } | undefined;

export async function bootVm(): Promise<void> {
  if (ports) return;
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
