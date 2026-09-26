import { defineConfig } from 'vitest/config';

// The unit suite never touches a network: every test injects its own fetch.
// The emu suite drives the REAL /v1 through the backend's hono app, so it
// needs the Firebase emulators (root `pnpm test:emu` boots them).
//
// '@tm/source' makes @tm/shared resolve to its TypeScript source, so the
// contract tests never read a stale shared/dist.
const conditions = ['@tm/source', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: ['test/**/*.emu.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'emu',
          include: ['test/**/*.emu.test.ts'],
          testTimeout: 45_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
