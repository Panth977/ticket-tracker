<!--
  Keeps the address bar owner-first (agents.html §AC): on /b/KEY, /x/{id},
  /bucket/{id} — or an owner-first URL whose handle is stale after a move or
  a rename — it rewrites the URL in place to /{handle}/b/KEY,
  /{handle}/x/{slug}, /{handle}/bucket/{slug}. No navigation, no reload.
-->
<script lang="ts">
  // The owner-first URLs are built from data (handles, slugs), not routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { myArtifacts } from '$lib/artifacts/store';
  import { myBuckets } from '$lib/bucket/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { myBoards } from '$lib/stores';
  import { parseThingPath } from './path';

  const boardsQ = $derived(myBoards(auth.uid));
  const artifactsQ = $derived(myArtifacts(auth.uid));
  const bucketsQ = $derived(myBuckets(auth.uid));

  $effect(() => {
    const t = parseThingPath(page.url.pathname);
    if (!t) return;
    let want: string | null = null;
    if (t.kind === 'board') {
      const b = $boardsQ.data.find((x) => x.key === t.ref.toUpperCase());
      if (b?.ownerHandle) want = `/${b.ownerHandle}/b/${b.key}${t.rest}`;
    } else if (t.kind === 'artifact') {
      const a = $artifactsQ.data.find(
        (x) => x.id === t.ref || (x.slug === t.ref && t.handle === x.ownerHandle),
      );
      if (a?.ownerHandle && a.slug) want = `/${a.ownerHandle}/x/${a.slug}${t.rest}`;
    } else {
      const m = $bucketsQ.data.find(
        (x) => x.id === t.ref || (x.slug === t.ref && t.handle === x.ownerHandle),
      );
      if (m?.ownerHandle && m.slug) want = `/${m.ownerHandle}/bucket/${m.slug}${t.rest}`;
    }
    if (want && want !== page.url.pathname)
      replaceState(want + page.url.search + page.url.hash, page.state);
  });
</script>
