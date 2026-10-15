/**
 * Runs scripts/lib/aggregates.mjs against the emulators in a PLAIN Node
 * process, for rules/migrate-aggregates.test.ts.
 *
 * Why a child process: this vitest config resolves with the 'module'
 * condition (and hands it to Node), under which firebase-admin/firestore loads
 * @opentelemetry/api's bundler-only ESM build and fails. Here Node resolves
 * normally; `--conditions=@tm/source` still gives us @tm/shared's source.
 *
 *   node --conditions=@tm/source --import tsx rules/_migrate-runner.ts '{"apply":true}'
 *
 * Prints the log lines, then one line `SUMMARY <json>`.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as S from '@tm/shared';
import { migrateAggregates } from '../../scripts/lib/aggregates.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}') as {
  projectId: string;
  bucket: string;
  ownerUid: string;
  apply: boolean;
  now?: number;
  which?: 'aggregates';
};
const app = initializeApp({ projectId: opts.projectId, storageBucket: opts.bucket });
const log = (m: string) => console.log(m);
const s = await migrateAggregates(
  { S, db: getFirestore(app) },
  { apply: opts.apply, now: opts.now ?? 1_000, log },
);
console.log(`SUMMARY ${JSON.stringify(s)}`);
process.exit(0);
