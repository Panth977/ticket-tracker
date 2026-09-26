/**
 * Search: ticket full-text (Typesense via a scoped key, Firestore fallback in
 * dev) and the ⌘K providers.
 *   import { searchTickets } from '$lib/search';   // e.g. the editor's '#' picker
 */
export { searchTickets, resetSearchKey } from './tickets';
export type { TicketHit, SearchOptions } from './tickets';
export { rank, score, tokenize } from './match';
export { retainSearchProviders } from './providers';
export { default as SearchProviders } from './SearchProviders.svelte';
