/**
 * TEMPORARY stand-in for backend/vitest.config.ts (scaffold-owned) until its
 * REQUEST lands: identical, except modules are resolved WITHOUT the
 * 'module' condition — with it, @opentelemetry/api (pulled in by
 * @google-cloud/firestore / google-gax) resolves to its ESM build, whose
 * extensionless imports Node cannot load, so any test touching Firestore fails.
 *
 *   pnpm exec vitest run --config test/harness/vitest.config.ts --project emu
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Scaffold's list minus 'module' (see above) — needed in BOTH lists.
const conditions = ['@tm/source', 'node', 'development|production'];

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['test/**/*.emu.test.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'emu', include: ['test/**/*.emu.test.ts'], testTimeout: 30_000 },
      },
    ],
  },
});
