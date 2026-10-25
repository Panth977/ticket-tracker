/**
 * Move a VM's data (TM_DATA_DIR) into the IceBase server's (TM_DATA_DIR/icebase): documents,
 * people, files and the realtime database (./icebaseServer.ts). Then the deploy runs
 * `icebase serve` (TM_PLATFORM=icebase) on the same volume.
 *
 *   docker service scale ticket-tracker=0                       # stop the server first
 *   docker run --rm -v tm-data:/data -e TM_PLATFORM=vm ghcr.io/panth977/ticket-tracker \
 *     node backend/lib/migrate/icebaseServerCli.js              # dry run: counts + what does not fit
 *   … node backend/lib/migrate/icebaseServerCli.js --apply      # copy, then read back and compare
 *
 * --unchecked also copies documents that do not fit the schema (as they are). The VM's own
 * files are only read: going back is running the VM build again.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/types.js';
import { sqliteDb } from '../db/sqlite/index.js';
import { dataDir, platform } from '../runtime/platform.js';
import { migrateToIcebaseServer } from './icebaseServer.js';

if (platform() !== 'vm') {
  console.error('Set TM_PLATFORM=vm: this moves a VM’s own data into the IceBase server’s.');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const unchecked = process.argv.includes('--unchecked');
const s = await migrateToIcebaseServer({
  source: sqliteDb() as unknown as Db,
  dataDir: dataDir(),
  ...(process.env.TM_BLOB_DIR ? { blobDir: process.env.TM_BLOB_DIR } : {}),
  apply,
  unchecked,
  log: (m) => console.log(`icebase │ ${m}`),
});
const report = join(dataDir(), `icebase-server-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(report, JSON.stringify(s, null, 2));
const d = s.documents;
console.log(
  `${apply ? 'applied' : 'dry run — nothing written (add --apply)'}:\n` +
    `  documents  ${d.documents} found, ${d.copied} copied, ${d.invalid.length} not fitting the schema${unchecked ? ' (copied anyway)' : ' (left out)'}, ${d.mismatched.length} mismatched after copy\n` +
    `  people     ${s.people.found} found, ${s.people.imported} imported, ${s.people.failed.length} failed\n` +
    `  files      ${s.files.found} found (${s.files.bytes} bytes), ${s.files.copied} copied, ${s.files.mismatched.length} mismatched\n` +
    `  realtime   ${s.realtime.found ? `${s.realtime.keys} top-level keys${s.realtime.matches === null ? '' : s.realtime.matches ? ', identical' : ', DIFFERENT'}` : 'none'}\n` +
    `Report: ${report}`,
);
for (const i of d.invalid.slice(0, 20)) console.log(`  ✗ ${i.path}: ${i.why}`);
for (const f of s.people.failed) console.log(`  ✗ person ${f.uid}: ${f.error}`);
const bad = d.mismatched.length + s.people.failed.length + s.files.mismatched.length + (s.realtime.matches === false ? 1 : 0);
process.exit(apply && bad ? 1 : 0);
