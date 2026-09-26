/**
 * Which URLs are STATIC PAGES rather than SPA routes.
 *
 * The app is a single shell that answers every route, so the service worker's
 * navigation rule is "serve the shell". But the deploy also ships real HTML
 * pages beside it — /integrate (what an orchestrator is pointed at), /qa/mobile
 * (the phone preview), /offline.html — and answering those with the shell makes
 * the SPA report its own Not found. That only happens once the worker is
 * installed, which is exactly when it is hardest to notice.
 *
 * `files` from $service-worker lists the static directory as it is served, so
 * the mapping is derived from it: the file itself, and for a directory index
 * both the directory and the bare path hosting redirects from.
 */
export function staticPages(files: readonly string[], base = ''): Map<string, string> {
  const pages = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith('.html')) continue;
    pages.set(f, f);
    if (!f.endsWith('/index.html')) continue;
    const dir = f.slice(0, -'index.html'.length); // /integrate/
    if (dir === `${base}/`) continue; // the SPA's own root belongs to the shell
    pages.set(dir, f);
    pages.set(dir.slice(0, -1), f); // /integrate, before hosting's redirect
  }
  return pages;
}
