import { defineConfig } from 'vitest/config';

// "@tm/source" makes @tm/shared resolve to its TypeScript source, so backend tests
// never depend on a stale shared/dist.
// Vite's default server conditions, prefixed with ours.
const conditions = ['@tm/source', 'node', 'development|production']; // no 'module': @opentelemetry/api's ESM build is unloadable by Node (integration fix)

export default defineConfig({
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
        // Tests that talk to the Firebase emulators. Run them via the root
        // `pnpm test:emu` (holds the emulators lock and boots the suite).
        //
        // ONE FILE AT A TIME. Every file drives the SAME emulator, and its
        // commands are Firestore transactions over the same few documents
        // (a board, its counters, its tickets): run in parallel they take
        // each other's locks and time out at random, in whichever suites
        // happened to collide. Sequential is slower and always true.
        extends: true,
        test: {
          name: 'emu',
          include: ['test/**/*.emu.test.ts'],
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
