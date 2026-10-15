/**
 * The restructure migration on THIS deploy's own stores (a VM: SQLite + disk,
 * TM_DATA_DIR) — the same code the Firebase script runs (./restructure.ts).
 *
 *   docker service scale ticket-tracker=0                 # stop the server first
 *   docker run --rm -v tm-data:/data ghcr.io/panth977/ticket-tracker \
 *     node backend/lib/migrate/cli.js            # dry run: what it would do
 *   … node backend/lib/migrate/cli.js --apply    # do it
 *   docker service scale ticket-tracker=1
 *
 * Stop the server while it runs: the server keeps its own view of the data
 * and would not see these writes until it restarts.
 */
import { storageBucket } from '../blob/index.js';
import { db } from '../db/index.js';
import { migrateRestructure } from './restructure.js';

const apply = process.argv.includes('--apply');
const s = await migrateRestructure({
  db: db(),
  bucket: storageBucket(),
  apply,
  log: (m) => console.log(`restructure │ ${m}`),
});
console.log(apply ? 'applied' : 'dry run — nothing written (add --apply)', JSON.stringify(s));
process.exit(0);
