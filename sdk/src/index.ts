/**
 * @tm/sdk — the typed, zero-dependency client an orchestrator imports
 * (docs/plan/agents.html §M).
 *
 *   import { createClient } from 'https://taskmanager-example.web.app/lib/v1/sdk.js'
 *
 *   const tm = createClient({ token: process.env.TM_TOKEN })   // the token picks the board
 *   await tm.work(async ({ ticket, tm }) => { … })             // §W: wakes, does not poll
 *
 * Everything is re-exported from here; the build concatenates these modules
 * into one dist/sdk.ts and one flat dist/sdk.d.ts, so a URL import gets the
 * same names with the same types.
 */
export * from './types.js';
export * from './errors.js';
export * from './http.js';
export * from './sse.js';
export * from './watch.js';
export * from './client.js';
export * from './work.js';
export * from './mcp.js';
