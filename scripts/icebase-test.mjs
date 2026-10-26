// Run a command against a fresh IceBase server (TM_ICEBASE=emulator): `icebase serve` on a free
// port with an empty data directory and TaskManager's functions, then the command with that
// server in its environment. Used by `pnpm test:emu:icebase`.
//   node scripts/icebase-test.mjs -- <command…>
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cmd = process.argv.slice(process.argv.indexOf('--') + 1);
const port = await new Promise((ok) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});
const data = mkdtempSync(join(tmpdir(), 'tm-icebase-test-'));
const origin = `http://127.0.0.1:${port}`;
// The tests run as they do on Firebase's emulators (no APP_URL: links stay relative); the
// server is told its address.
const env = {
  ...process.env,
  TM_ICEBASE: 'emulator',
  TM_DEV: '1',
  TM_DATA_DIR: data,
  ICEBASE_PUBLIC_URL: origin,
  ICEBASE_ADMIN_TOKEN: randomBytes(24).toString('base64url'),
  ICEBASE_LOG_ERRORS: process.env.ICEBASE_LOG_ERRORS ?? '',
};
// The server's own functions dispatch their tasks; only the in-process test api holds them in memory.
const serverEnv = { ...env, APP_URL: origin, API_URL: origin };
delete serverEnv.TM_QUEUE;
for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST', 'FUNCTIONS_EMULATOR']) delete serverEnv[k];
const server = spawn(process.execPath, [join(root, 'scripts', 'icebase.mjs'), 'serve', '--port', String(port), '--host', '127.0.0.1', '--data', join(data, 'icebase')], { env: serverEnv, stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => {
  server.kill();
  rmSync(data, { recursive: true, force: true });
};
process.on('exit', stop);
for (let i = 0; i < 600; i++) {
  if (await fetch(`${origin}/config.json`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`[icebase-test] IceBase server on ${origin}`);
const child = spawn(cmd[0], cmd.slice(1), { env: { ...env, ICEBASE_EMULATOR_HOST: `127.0.0.1:${port}` }, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
