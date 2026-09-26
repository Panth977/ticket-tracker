import { defineConfig } from 'vitest/config';

// Vite's default server conditions, prefixed with ours.
const conditions = ['@tm/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'] } },
      {
        // @firebase/rules-unit-testing suites; need firestore/storage/database
        // emulators — run through `pnpm --filter @tm/qaqc test:rules` or root `test:emu`.
        extends: true,
        test: {
          name: 'rules',
          include: ['rules/**/*.test.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
