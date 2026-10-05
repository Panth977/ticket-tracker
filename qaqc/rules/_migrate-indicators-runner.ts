/**
 * Runs scripts/lib/indicators.mjs against the firestore emulator in a PLAIN
 * Node process, for rules/migrate-indicators.test.ts (why a child process:
 * see _migrate-runner.ts).
 *
 *   node --conditions=@tm/source --import tsx rules/_migrate-indicators-runner.ts '{"projectId":"…","apply":true}'
 *
 * Prints the log lines, then one line `SUMMARY <json>`.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as S from '@tm/shared';
import { migrateIndicators } from '../../scripts/lib/indicators.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}') as { projectId: string; apply: boolean };
const app = initializeApp({ projectId: opts.projectId });
const summary = await migrateIndicators(
  { S, db: getFirestore(app) },
  { apply: opts.apply, log: (m) => console.log(m) },
);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
process.exit(0);
