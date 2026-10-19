/**
 * DICTIONARY (docs/plan/dictionary.html) — the stored shapes.
 *
 *   dictionaries/{dictionaryId}                    DictionarySchema
 *   dictionaries/{dictionaryId}/content/entries    DictionaryContentSchema
 *
 * A dictionary is a named set of KEY → VALUE entries (any JSON), owned like a
 * bucket: its people are its own (owner / editor / viewer), and boards,
 * artifacts and agents use it only through a GRANT stored here — a ceiling,
 * never a floor. dictionaryReach() is the one answer to "what may this
 * principal do". It replaces the Env pairs things used to carry: an
 * orchestrator hands its agents every dictionary granted to their board and
 * to the agent itself (GET /v1/env).
 *
 * The entries live in ONE document beside the dictionary, so the sidebar and
 * the lists (which read the dictionary documents) never load them. Values are
 * stored as JSON text: Firestore cannot hold every JSON value (nested arrays),
 * and the text round-trips exactly.
 */
import { z } from 'zod';
import { BoardDriveStorageSchema, BoardMoveSchema } from '../bucket/drive.js';
import { OwnedFieldsShape } from '../org/owner.js';
import { DESCRIPTION_MAX, IndicatorSchema, type Indicator } from '../types/indicator.js';
import { ArtifactIdSchema } from '../artifacts/schema.js';
import {
  AgentIdSchema,
  BoardIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  UidSchema,
  type BoardRole,
} from '../types/index.js';

export const DICTIONARY_ROLES = ['owner', 'editor', 'viewer'] as const;
export const DictionaryRoleSchema = z.enum(DICTIONARY_ROLES);
export type DictionaryRole = z.infer<typeof DictionaryRoleSchema>;
/** A role that may be GIVEN by sharing — the owner is set at create. */
export const DictionaryShareRoleSchema = z.enum(['editor', 'viewer']);
export type DictionaryShareRole = z.infer<typeof DictionaryShareRoleSchema>;

/** What a board, an artifact or an agent was granted. A ceiling, never a floor. */
export const DICTIONARY_GRANTS = ['read', 'write'] as const;
export const DictionaryGrantSchema = z.enum(DICTIONARY_GRANTS);
export type DictionaryGrant = z.infer<typeof DictionaryGrantSchema>;

export const DictionaryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Dictionary id');
export type DictionaryId = z.infer<typeof DictionaryIdSchema>;

// ─── limits ──────────────────────────────────────────────────────────────────
export const DICTIONARY_NAME_MAX = 80;
export const DICTIONARY_DESCRIPTION_MAX = DESCRIPTION_MAX;
export const DICTIONARY_ENTRIES_MAX = 500;
export const DICTIONARY_KEY_MAX = 128;
/** One value, as JSON text. */
export const DICTIONARY_VALUE_MAX_BYTES = 64 * 1024;
/** Every value of one dictionary together, as JSON text (a Firestore document holds 1 MiB). */
export const DICTIONARY_TOTAL_MAX_BYTES = 512 * 1024;
export const DICTIONARIES_OWNED_MAX = 100;
export const DICTIONARY_GRANTS_MAX = 50;

export const DICTIONARY_DEFAULT_INDICATOR: Indicator = { kind: 'emoji', emoji: '📖' };

/**
 * A key: 1–128 of letters, digits and _ . : - , starting with a letter, a
 * digit or _. Env-style names (API_URL) are keys; so are 'theme.primary' and
 * 'limits:daily'. Only the env-style ones become process environment.
 */
export const DICTIONARY_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
export const DictionaryKeySchema = z
  .string()
  .regex(DICTIONARY_KEY_RE, 'Letters, digits and _ . : - ; at most 128; not starting with . : -');

/** Process environment names: what an orchestrator may export (POSIX-ish). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Is this a JSON value (what JSON.parse can give back)? */
export function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

/** Any JSON value: a string, a number, true/false, null, an array or an object. */
export const DictionaryValueSchema = z
  .unknown()
  .refine((v) => v !== undefined && isJsonValue(v), 'A JSON value')
  .refine(
    (v) => utf8Bytes(JSON.stringify(v)) <= DICTIONARY_VALUE_MAX_BYTES,
    `At most ${DICTIONARY_VALUE_MAX_BYTES / 1024} KB per value`,
  );

/** One entry as the API speaks it. */
export const DictionaryEntrySchema = z.object({
  key: DictionaryKeySchema,
  value: DictionaryValueSchema,
});
export type DictionaryEntry = { key: string; value: unknown };

export const DictionarySchema = z.object({
  name: z.string().min(1).max(DICTIONARY_NAME_MAX),
  description: z.string().max(DICTIONARY_DESCRIPTION_MAX).nullable(),
  /** indicators.html: what the sidebar, dropdowns and cards draw. */
  indicator: IndicatorSchema.optional(),
  ownerUid: UidSchema,
  ...OwnedFieldsShape,
  /** §AC: its name in URLs (/{handle}/dictionary/{slug}), unique per owner. */
  slug: z.string().optional(),
  /** Every PERSON with a role, the owner included. Rules read this. */
  access: z.record(UidSchema, DictionaryRoleSchema),
  /** The keys of `access`, derived (a list query needs array-contains). */
  memberUids: z.array(UidSchema),
  /** Boards that may use it: their members (as their role allows) and their agents. */
  boards: z.record(BoardIdSchema, DictionaryGrantSchema),
  /** Artifacts whose page may use it (BackendDriver.dictionary). */
  artifacts: z.record(ArtifactIdSchema, DictionaryGrantSchema),
  /** Agents that may use it wherever they work (their orchestrator's env). */
  agents: z.record(AgentIdSchema, DictionaryGrantSchema),
  /** The keys of `boards` / `artifacts` / `agents`, derived — where(…, 'array-contains', id). */
  boardIds: z.array(BoardIdSchema),
  artifactIds: z.array(ArtifactIdSchema),
  agentIds: z.array(AgentIdSchema),
  /** Kept by dictionarySet. */
  stats: z.object({
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  /** bucket.html §L5: kept in this Drive folder (its settings and its data). Absent = in the database. */
  storage: BoardDriveStorageSchema.optional(),
  /** bucket.html §L4: a move to the other storage, while it runs (or after it failed). */
  move: BoardMoveSchema.nullable().optional(),
  archivedAt: MillisSchema.nullable(),
  createdAt: MillisSchema,
  updatedAt: MillisSchema,
});
export type Dictionary = z.infer<typeof DictionarySchema>;
export type DictionaryWithId = Dictionary & { id: string };

/** dictionaries/{d}/content/entries — the entries, in order, values as JSON text. */
export const DictionaryContentSchema = z.object({
  entries: z.array(z.object({ k: DictionaryKeySchema, v: z.string() })),
  updatedAt: MillisSchema,
  updatedBy: PrincipalIdSchema,
});
export type DictionaryContent = z.infer<typeof DictionaryContentSchema>;

/** The UTF-8 length of a string (no TextEncoder: shared runs without DOM types). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Stored → API. A value that does not parse (never written so) reads as its text. */
export function entriesOut(
  c: Pick<DictionaryContent, 'entries'> | null | undefined,
): DictionaryEntry[] {
  return (c?.entries ?? []).map(({ k, v }) => {
    try {
      return { key: k, value: JSON.parse(v) as unknown };
    } catch {
      return { key: k, value: v };
    }
  });
}

/** API → stored, with the limits checked. Throws a message when one is broken. */
export function entriesIn(list: readonly { key: string; value?: unknown }[]): {
  entries: DictionaryContent['entries'];
  bytes: number;
} {
  if (list.length > DICTIONARY_ENTRIES_MAX)
    throw new Error(`At most ${DICTIONARY_ENTRIES_MAX} entries`);
  const seen = new Set<string>();
  let bytes = 0;
  const entries = list.map(({ key, value }) => {
    if (seen.has(key)) throw new Error(`The key ${key} is there twice`);
    seen.add(key);
    const v = JSON.stringify(value);
    bytes += utf8Bytes(key) + utf8Bytes(v);
    return { k: key, v };
  });
  if (bytes > DICTIONARY_TOTAL_MAX_BYTES)
    throw new Error(`At most ${DICTIONARY_TOTAL_MAX_BYTES / 1024} KB in one dictionary`);
  return { entries, bytes };
}

/**
 * Entries → process environment: env-style keys only; a string as it is,
 * anything else as its JSON text. Later dictionaries win, so callers pass
 * them weakest first.
 */
export function entriesToEnv(
  lists: readonly (readonly DictionaryEntry[])[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const list of lists)
    for (const { key, value } of list) {
      if (!ENV_NAME_RE.test(key)) continue;
      env[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  return env;
}

// ─── who may do what ─────────────────────────────────────────────────────────

/**
 * What a principal may do in one dictionary:
 *   'manage'  owner: share, grant, rename, archive, delete
 *   'write'   change entries
 *   'read'    read entries
 *   null      nothing (and the dictionary answers 404)
 */
export type DictionaryReach = 'manage' | 'write' | 'read' | null;

/**
 * THE ONE ANSWER. `uid` = a person's own role; `boardRoles` = the principal's
 * roles on boards (only the GRANTED ones matter: a 'read' grant gives every
 * member 'read', a 'write' grant gives editors and admins 'write'); `agentId`
 * = the agent itself, when a grant names it. The best route wins. Archived is
 * read-only to everyone but the owner's manage.
 */
export function dictionaryReach(
  d: Pick<Dictionary, 'access' | 'boards' | 'archivedAt'> & {
    agents?: Dictionary['agents'] | undefined;
  },
  who: {
    uid?: string | null | undefined;
    boardRoles?: ReadonlyMap<string, BoardRole | null | undefined> | undefined;
    agentId?: string | null | undefined;
  },
): DictionaryReach {
  const rank = { read: 1, write: 2, manage: 3 } as const;
  let best: Exclude<DictionaryReach, null> | null = null;
  const take = (r: Exclude<DictionaryReach, null>) => {
    if (!best || rank[r] > rank[best]) best = r;
  };
  const role = who.uid ? d.access[who.uid] : undefined;
  if (role === 'owner') take('manage');
  else if (role === 'editor') take('write');
  else if (role === 'viewer') take('read');
  for (const [boardId, grant] of Object.entries(d.boards ?? {})) {
    const br = who.boardRoles?.get(boardId);
    if (!br) continue;
    if (grant === 'write' && (br === 'admin' || br === 'editor')) take('write');
    else take('read');
  }
  const own = who.agentId ? d.agents?.[who.agentId] : undefined;
  if (own) take(own);
  if (best === 'write' && d.archivedAt != null) return 'read';
  return best;
}

export const dictionaryCan = {
  read: (r: DictionaryReach): boolean => r !== null,
  write: (r: DictionaryReach): boolean => r === 'write' || r === 'manage',
  manage: (r: DictionaryReach): boolean => r === 'manage',
};

/** An artifact's page: the GRANT is the ceiling, the VIEWER's own reach the floor. */
export function dictionaryArtifactReach(
  d: Pick<Dictionary, 'artifacts'>,
  artifactId: string,
  viewer: DictionaryReach,
): 'read' | 'write' | null {
  const grant = d.artifacts?.[artifactId];
  if (!grant || !viewer) return null;
  return grant === 'write' && dictionaryCan.write(viewer) ? 'write' : 'read';
}

/** The app's route for a dictionary (frontend lib/layout/routes mirrors it). */
export const dictionaryAppPath = (dictionaryId: string): string => `/dictionary/${dictionaryId}`;
