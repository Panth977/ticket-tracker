import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Pure SPA: Firebase Hosting serves build/ and rewrites every unknown path to
    // index.html (see firebase.json); /api etc. go to the `api` function.
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
    alias: { $lib: 'src/lib' },
    serviceWorker: {
      /*
       * What `files` hands the service worker to precache (agents.html § S): the
       * app shell only — icons, the manifest, the offline page, the favicon, the
       * merged messaging worker. static/lib (the hosted SDK), static/integrate
       * and the llms*.txt files are megabytes meant for orchestrators fetching
       * them over the network, never for a phone's offline cache.
       */
      files: (path) =>
        !path.startsWith('lib/') &&
        !path.startsWith('integrate/') &&
        path !== 'integrate.json' &&
        !/^llms.*\.txt$/.test(path),
    },
  },
  // Runes for our own code only: lucide-svelte ships legacy ($$props) components,
  // which fail to compile when runes are forced on node_modules too.
  vitePlugin: {
    dynamicCompileOptions: ({ filename }) =>
      filename.includes('node_modules') ? undefined : { runes: true },
  },
};

export default config;
