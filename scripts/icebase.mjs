// The IceBase CLI (from JSR, which ships no bin), run where TaskManager's IceBase config is
// (backend/icebase.config.ts): `node scripts/icebase.mjs serve`, `… docs`, `… check`.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const backend = fileURLToPath(new URL('../backend/', import.meta.url));
process.chdir(backend);
await import(pathToFileURL(createRequire(`${backend}package.json`).resolve('@panth977/icebase-cli/cli')).href);
