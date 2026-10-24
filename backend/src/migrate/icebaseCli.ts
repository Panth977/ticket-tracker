/**
 * Move a VM's database into IceBase (./icebase.ts), on THIS deploy's own data (TM_DATA_DIR).
 *
 *   docker service scale ticket-tracker=0                       # stop the server first
 *   docker run --rm -v tm-data:/data -e TM_PLATFORM=vm ghcr.io/panth977/ticket-tracker \
 *     node backend/lib/migrate/icebaseCli.js                    # dry run: counts + what does not fit
 *   … node backend/lib/migrate/icebaseCli.js --apply            # copy into /data/icebase, then compare
 *   then run the server with TM_DB=icebase, and scale back to 1
 *
 * --unchecked also copies documents that do not fit the schema (as they are). The SQLite files
 * are only read: going back is running without TM_DB=icebase.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/types.js';
import { sqliteDb } from '../db/sqlite/index.js';
import { icebaseFirestore, icebaseRawFirestore, icebaseServer } from '../icebase/app.js';
import { dataDir, platform } from '../runtime/platform.js';
import { migrateToIcebase } from './icebase.js';

if (platform() !== 'vm') {
  console.error('Set TM_PLATFORM=vm: this moves a VM’s own SQLite data into IceBase (Firebase needs no move).');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const unchecked = process.argv.includes('--unchecked');
await icebaseServer();
const s = await migrateToIcebase({
  source: sqliteDb() as unknown as Db,
  target: icebaseFirestore(),
  raw: icebaseRawFirestore(),
  apply,
  unchecked,
  log: (m) => console.log(`icebase │ ${m}`),
});
const report = join(dataDir(), `icebase-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(report, JSON.stringify(s, null, 2));
console.log(
  `${apply ? 'applied' : 'dry run — nothing written (add --apply)'}: ${s.documents} documents, ${s.copied} copied, ${s.invalid.length} not fitting the schema${unchecked ? ' (copied anyway)' : ' (left out)'}, ${s.mismatched.length} mismatched after copy. Report: ${report}`,
);
for (const i of s.invalid.slice(0, 20)) console.log(`  ✗ ${i.path}: ${i.why}`);
process.exit(s.mismatched.length ? 1 : 0);
