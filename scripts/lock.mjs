#!/usr/bin/env node
/**
 * Run a command under a named lock, so two `pnpm` installs or two emulator
 * suites started from different terminals (or agents) do not collide:
 *
 *   node scripts/lock.mjs <name> -- <command...>
 *
 * A directory is created atomically or not at all — that is the whole lock.
 * A lock older than 30 minutes is presumed dead and taken over; waiting
 * longer than an hour gives up.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCKS = join(fileURLToPath(new URL('..', import.meta.url)), '.locks');
const [name, ...rest] = process.argv.slice(2);
const sep = rest.indexOf('--');
const argv = sep >= 0 ? rest.slice(sep + 1) : rest;
if (!name || !argv.length) {
  console.error('usage: node scripts/lock.mjs <name> -- <command...>');
  process.exit(2);
}
mkdirSync(LOCKS, { recursive: true });
const dir = join(LOCKS, name);
const started = Date.now();
for (;;) {
  try {
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner'), `${process.pid} ${new Date().toISOString()} ${argv.join(' ')}\n`);
    break;
  } catch {
    try {
      if (Date.now() - statSync(dir).mtimeMs > 30 * 60_000) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
    } catch {
      /* raced with the release */
    }
    if (Date.now() - started > 60 * 60_000) {
      console.error(`waited an hour for lock "${name}"`);
      process.exit(1);
    }
    spawnSync('sleep', ['3']);
  }
}
let code;
try {
  const env = { ...process.env };
  // firebase-tools needs Java 21; prefer a Homebrew one when the default is older.
  if (name === 'emulators') {
    for (const p of ['/opt/homebrew/opt/openjdk@21/bin', '/usr/local/opt/openjdk@21/bin']) {
      if (existsSync(p)) env.PATH = `${p}:${env.PATH}`;
    }
  }
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: argv.length === 1, env });
  code = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code ?? 1);
