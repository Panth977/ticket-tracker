<!--
  Account (app.json › Account): a section menu on the left, the section on
  the right. Every section is also one click away in the Account menu.
-->
<script lang="ts">
  // hrefs are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { accountSections, routes } from '$lib/layout/routes';
  import { amIAdmin } from '$lib/account/allow';
  import { auth } from '$lib/firebase/auth.svelte';

  let { children }: { children: Snippet } = $props();
  const current = $derived(page.url.pathname.split('/')[2] ?? 'profile');
  // §X — the Users module is the admin's; nobody else is shown it.
  const sections = $derived(accountSections(amIAdmin(auth.user?.email)));
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8 md:flex-row md:gap-10">
  <nav aria-label="Account" class="md:w-48 md:shrink-0">
    <h1 class="mb-3 text-lg font-semibold md:mb-4">Account</h1>
    <ul class="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible">
      {#each sections as s (s.id)}
        <li class="shrink-0">
          <a
            href={routes.account(s.id)}
            aria-current={current === s.id ? 'page' : undefined}
            class="block rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors {current ===
            s.id
              ? 'bg-surface-2 font-medium text-text'
              : 'text-muted hover:bg-surface-2 hover:text-text'}"
          >
            {s.label}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
  <div class="min-w-0 flex-1">
    {@render children()}
  </div>
</div>
