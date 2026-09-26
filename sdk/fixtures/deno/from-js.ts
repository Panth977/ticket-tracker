/**
 * Deno, importing the JS BUNDLE by URL — §M's second Deno row.
 *
 *   import { createClient } from 'https://…/lib/v1/sdk.js'
 *
 * A URL import only carries types if the server says where they are, so the
 * local server in fixtures/check.mjs sends `X-TypeScript-Types: ./sdk.d.ts`
 * exactly as hosting will. If that header (or the declaration file behind it)
 * were missing, Deno would treat the module as untyped `any` — and then the
 * `@ts-expect-error` lines at the bottom would report "unused directive" and
 * `deno check` would fail. So this file fails BOTH ways round.
 */
import { createClient, isTmError, mcpTools, TmError, type McpTool, type Ticket } from '__ORIGIN__/sdk.js';

const tm = createClient({ token: 'tm_live_example' });

export async function run(): Promise<void> {
  const t: Ticket = await tm.tickets.get('ENG-42');
  const tools: McpTool[] = await mcpTools(tm, { only: ['get_ticket'] });
  const beat = tm.heartbeat.start({ ticket: t.key, message: 'Running tests' });
  await beat.done();
  try {
    await tm.tickets.move(t.key, 'QA');
  } catch (e) {
    if (isTmError(e)) console.error(e.code, e.status);
    if (e instanceof TmError) console.error(e.problem);
  }
  console.log(tools.length, tm.version);
}

// @ts-expect-error a client needs a token
createClient({});
// @ts-expect-error move() needs the stage to move to
void tm.tickets.move('ENG-42');
// @ts-expect-error a ticket key is a string
export const wrong: number = (await tm.tickets.get('ENG-42')).key;
