/**
 * Cold-start module discovery: imports every handler module so its
 * defineCommand / defineTask / defineSchedule / defineTrigger / door() call
 * registers it. Works from src/ (vitest, .ts) and lib/ (deployed, .js).
 *
 * Loaded (top level of each dir only): commands/, jobs/, triggers/, doors/,
 * doors/hooks/. Skipped: files starting with '_' or named index, tests,
 * declaration and map files. Helpers belong in other directories
 * (e.g. src/tickets/, src/notify/) and are imported by the handlers.
 *
 * NO TOP-LEVEL AWAIT anywhere in the function graph: the Functions runtime
 * loads lib/index.js with require() (Node 22 require(esm)), which refuses
 * async module graphs. index.ts therefore uses autoloadSync(); tests (vite,
 * .ts sources) use the async autoload(). Both share Node's module cache, so
 * a module never registers twice.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join } from 'node:path';

export const AUTOLOAD_DIRS = ['commands', 'jobs', 'triggers', 'doors', 'doors/hooks'] as const;

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const ext = extname(fileURLToPath(import.meta.url)); // '.ts' under vitest, '.js' when built

function modulesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(srcRoot, dir));
  } catch {
    return []; // the directory does not exist yet (its step has not run)
  }
  return names
    .filter((n) => n.endsWith(ext) && !n.endsWith('.d.ts') && !/\.(test|spec)\./.test(n))
    .filter((n) => !n.startsWith('_') && n !== `index${ext}`)
    .sort()
    .map((n) => join(srcRoot, dir, n));
}

let loaded: Promise<string[]> | undefined;
let loadedSync: string[] | undefined;

/**
 * Synchronous variant for index.ts in the built output (lib/*.js): require()s
 * each ESM module. Under vitest (.ts sources) it is a no-op — use autoload().
 */
export function autoloadSync(): string[] {
  if (loadedSync) return loadedSync;
  if (ext !== '.js') return (loadedSync = []);
  const req = createRequire(import.meta.url);
  const files = AUTOLOAD_DIRS.flatMap(modulesIn);
  for (const f of files) req(f);
  loaded = Promise.resolve(files);
  return (loadedSync = files);
}

/** Import every handler module once. Resolves to the list of files loaded. */
export function autoload(): Promise<string[]> {
  return (loaded ??= (async () => {
    const files = AUTOLOAD_DIRS.flatMap(modulesIn);
    for (const f of files) await import(pathToFileURL(f).href);
    return files;
  })());
}
