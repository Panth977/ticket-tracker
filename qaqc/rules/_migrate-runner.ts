/**
 * Runs scripts/lib/attachments-to-memory.mjs against the emulators in a PLAIN
 * Node process, for rules/migrate-attachments.test.ts.
 *
 * Why a child process: this vitest config resolves with the 'module'
 * condition (and hands it to Node), under which firebase-admin/firestore loads
 * @opentelemetry/api's bundler-only ESM build and fails. Here Node resolves
 * normally; `--conditions=@tm/source` still gives us @tm/shared's source.
 *
 *   node --conditions=@tm/source --import tsx rules/_migrate-runner.ts '{"ownerUid":"…","apply":true}'
 *
 * Prints the log lines, then one line `SUMMARY <json>`.
 */
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as S from '@tm/shared';
import { migrateAttachmentsToMemory } from '../../scripts/lib/attachments-to-memory.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}') as {
  projectId: string;
  bucket: string;
  ownerUid: string;
  apply: boolean;
  now?: number;
};
const app = initializeApp({ projectId: opts.projectId, storageBucket: opts.bucket });
const summary = await migrateAttachmentsToMemory(
  { S, db: getFirestore(app), bucket: getStorage(app).bucket(opts.bucket), FieldValue },
  {
    ownerUid: opts.ownerUid,
    apply: opts.apply,
    now: opts.now ?? 1_000,
    log: (m) => console.log(m),
  },
);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
process.exit(0);
