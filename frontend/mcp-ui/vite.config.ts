/**
 * The TaskManager view for MCP Apps (backend/src/doors/mcpUi.ts): one
 * self-contained HTML file — every script and style inlined — because the
 * host's sandbox blocks every origin we do not declare, and declaring none is
 * the safest CSP there is. `emit.mjs` turns dist/index.html into the backend's
 * mcpUiHtml.gen.ts.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte({ compilerOptions: { runes: true } }), viteSingleFile()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
