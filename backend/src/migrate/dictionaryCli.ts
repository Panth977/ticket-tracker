/**
 * The env → dictionary migration on THIS deploy's own stores (a VM: SQLite,
 * TM_DATA_DIR) — the same code the Firebase script runs (./dictionary.ts).
 *
 *   docker service scale ticket-tracker=0                 # stop the server first
 *   docker run --rm -v tm-data:/data ghcr.io/panth977/ticket-tracker \
 *     node backend/lib/migrate/dictionaryCli.js           # dry run: what it would do
 *   … node backend/lib/migrate/dictionaryCli.js --apply   # do it
 *   docker service scale ticket-tracker=1
 */
import { db } from '../db/index.js';
import { migrateEnvToDictionaries } from './dictionary.js';

const apply = process.argv.includes('--apply');
const s = await migrateEnvToDictionaries({
  db: db(),
  apply,
  log: (m) => console.log(`dictionary │ ${m}`),
});
console.log(apply ? 'applied' : 'dry run — nothing written (add --apply)', JSON.stringify(s));
process.exit(0);
