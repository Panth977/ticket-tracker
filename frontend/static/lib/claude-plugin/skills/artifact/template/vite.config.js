import { defineConfig } from 'vite';

export default defineConfig({
  // THE ONE SETTING THAT MATTERS. An artifact is served under a path prefix
  // that changes every hour ({usercontent}/c/{capability}/…), so every asset
  // URL must be relative. Vite's default, '/', gives '/assets/app.js' — which
  // publishes fine, answers with a warning, and shows a blank page.
  base: './',
  build: { outDir: 'dist' },
});
