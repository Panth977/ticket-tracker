/**
 * notify(event, ticket, ctx, extra) — THE import path every command uses.
 * Points at the real router (router.ts); the api-core stub stays unused.
 */
export { notify, route } from './router.js';
