import { defineConfig } from 'vitest/config';

// '@tm/source' makes @tm/shared resolve to its TypeScript source, so the tests
// speak the protocol that is in the tree, never a stale shared/dist.
const conditions = ['@tm/source', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  // The driver is tested against a FAKE window (test/fakeWindow.ts): it needs
  // postMessage between two windows and a localStorage, nothing of a real DOM.
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
