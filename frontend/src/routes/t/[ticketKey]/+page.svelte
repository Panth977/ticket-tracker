<!--
  /t/KEY — the Ticket drawer as a full-width page (a shared link, 'Open as
  page'). keys/{KEY} resolves the ticket.
-->
<script lang="ts">
  // hrefs / goto() targets are built by lib/layout/routes; the SPA has no base path.
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import TicketDrawer from '$lib/ticket/TicketDrawer.svelte';
  import { routes } from '$lib/layout/routes';

  const ticketKey = $derived((page.params.ticketKey ?? '').toUpperCase());
</script>

<svelte:head><title>{ticketKey} · TaskManager</title></svelte:head>

{#key ticketKey}
  <TicketDrawer
    {ticketKey}
    layout="page"
    onClose={() => (history.length > 1 ? history.back() : goto(routes.home()))}
  />
{/key}
