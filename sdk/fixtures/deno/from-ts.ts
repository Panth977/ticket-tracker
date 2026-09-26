/**
 * Deno, importing the single TypeScript file by URL — §M's first Deno row.
 *
 *   import { createClient } from 'https://…/lib/v1/sdk.ts'
 *
 * Deno gets the real source, so types need nothing else. `__ORIGIN__` is
 * replaced with the local server's origin by fixtures/check.mjs.
 */
import { createClient, type Board, type Scope, type Ticket, type TmEvent } from '__ORIGIN__/sdk.ts';

const tm = createClient({ token: Deno.env.get('TM_TOKEN') ?? 'tm_live_example' });

export async function run(): Promise<void> {
  const me = await tm.me();
  const scopes: Scope[] = me.scopes;
  const board: Board = await tm.board();
  const t: Ticket = await tm.tickets.get('ENG-42');

  await tm.tasklists.set(t.key, { title: 'Plan', items: ['Read the spec', 'Write it'] });
  const answer = await tm.questions
    .ask(t.key, { title: 'Which database?', fields: [{ id: 'db', label: 'Database', type: 'single', options: ['Postgres', 'SQLite'] }] })
    .waitForAnswer();
  const db: string = answer.values.db;

  for await (const ev of tm.events.stream({ ack: true })) {
    const e: TmEvent = ev;
    void e;
    break;
  }
  console.log(board.key, scopes.length, db, tm.version);
}

// The types really arrived only if these are errors.
// @ts-expect-error a client needs a token
createClient({});
// @ts-expect-error 'deleted' is not a ticket state
void tm.tickets.state('ENG-42', 'deleted');
// @ts-expect-error a ticket key is a string
export const wrong: number = (await tm.tickets.get('ENG-42')).key;
