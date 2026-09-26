/**
 * Shared set-up for the security-rules suites.
 *
 * Runs only against the emulators (firestore, storage, database) — start them
 * with `pnpm --filter @tm/qaqc test:rules`, which takes the emulators lock and
 * wraps vitest in `firebase emulators:exec`. Host/port come from the
 * *_EMULATOR_HOST variables that emulators:exec sets.
 *
 * THE CAST. One board, one person per role, plus a stranger:
 *   ADMIN      admin of board_eng (and the owner of their own user doc)
 *   EDITOR     editor
 *   COMMENTER  commenter
 *   VIEWER     viewer
 *   STRANGER   on no board of ours — but admin of board_ops, so that "has a
 *              role somewhere" is never mistaken for "has a role here".
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import type { Database } from 'firebase/database';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '../../backend');

export const PROJECT_ID = 'demo-taskmanager';

export const ADMIN = 'u_admin';
export const EDITOR = 'u_editor';
export const COMMENTER = 'u_commenter';
export const VIEWER = 'u_viewer';
export const STRANGER = 'u_stranger';

export const BOARD = 'board_eng';
export const OTHER_BOARD = 'board_ops';
export const TICKET = 'tkt_0001';

export const emailOf = (uid: string) => `${uid.replace(/^u_/, '')}@example.com`;

export const ROLES: Record<string, 'admin' | 'editor' | 'commenter' | 'viewer'> = {
  [ADMIN]: 'admin',
  [EDITOR]: 'editor',
  [COMMENTER]: 'commenter',
  [VIEWER]: 'viewer',
};

export const MEMBERS = Object.keys(ROLES);
export const EVERYONE = [...MEMBERS, STRANGER];

export function readRules(
  file: 'firestore.rules' | 'storage.rules' | 'database.rules.json',
): string {
  return readFileSync(resolve(backend, file), 'utf8');
}

export async function makeEnv(which: {
  firestore?: boolean;
  storage?: boolean;
  database?: boolean;
}) {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    // Storage rules call firestore.get(), so the storage suite loads both.
    ...(which.firestore ? { firestore: { rules: readRules('firestore.rules') } } : {}),
    ...(which.storage ? { storage: { rules: readRules('storage.rules') } } : {}),
    ...(which.database ? { database: { rules: readRules('database.rules.json') } } : {}),
  });
}

/** A signed-in person, with a verified email as Auth would give them. */
export function as(env: RulesTestEnvironment, uid: string, verified = true): RulesTestContext {
  return env.authenticatedContext(uid, { email: emailOf(uid), email_verified: verified });
}

// The test library hands back compat instances; the modular functions accept
// them at runtime, so narrow the type once here.
export const fs = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore;
export const st = (ctx: RulesTestContext) => ctx.storage() as unknown as FirebaseStorage;
export const rt = (ctx: RulesTestContext) => ctx.database() as unknown as Database;

/** The board document, shaped like BoardSchema where the rules look. */
export function boardDoc(access: Record<string, string>, name = 'Engineering', key = 'ENG') {
  const readerUids = Object.keys(access);
  return {
    name,
    key,
    nextNumber: 2,
    access,
    stageGrants: {},
    readerUids,
    editorUids: readerUids.filter((u) => access[u] === 'admin' || access[u] === 'editor'),
    archivedAt: null,
    createdBy: readerUids[0] ?? null,
    createdAt: 0,
  };
}
