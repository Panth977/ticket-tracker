/**
 * WHAT EACH ENTITY KEEPS IN DRIVE (docs/plan/bucket.html §L5).
 *
 * The workspace — who owns what, who may see it, its name and key, the
 * counters — stays in the database: it is the instance's index. What an entity
 * IS lives in its Drive folder when its storage is Drive:
 *
 *   settings   its own settings (a board's stages, priorities, tags, fields…),
 *              read from and written to `settingsFile`; the database's document
 *              keeps every other field
 *   subtrees   whole collections under it, one JSON file per document
 *              (docfiles.ts); a secret one is sealed with its data key
 *   tickets    a board's tickets (files.ts, §L1–L4)
 *   manifest   `.tm-entity.json`: kind, name, owner and people by e-mail — what
 *              an instance needs to import the folder (§L7)
 */
import type { EntityKind } from './board.js';

export type { EntityKind };

export interface EntitySpec {
  /** Top-level document fields kept in Drive. */
  settingsFields: readonly string[];
  /** Where they are, in the entity's folder. */
  settingsFile: string;
  /** Collections under the entity kept as files: name → secret? */
  subtrees: Readonly<Record<string, { secret: boolean; depth?: number }>>;
}

export const ENTITY_SPECS: Readonly<Record<EntityKind, EntitySpec>> = {
  boards: {
    settingsFields: [
      'stages',
      'priorities',
      'tags',
      'fields',
      'aggFields',
      'defaultViewId',
      'settings',
    ],
    settingsFile: 'settings',
    subtrees: {
      views: { secret: false },
      templates: { secret: false },
      // A webhook's deliveries/ log stays in the database: only the webhook itself moves.
      webhooks: { secret: true, depth: 2 },
      integrations: { secret: true },
    },
  },
  dictionaries: {
    settingsFields: [],
    settingsFile: 'settings',
    subtrees: { content: { secret: true } },
  },
  buckets: {
    settingsFields: [],
    settingsFile: '.tm-settings',
    subtrees: {},
  },
  artifacts: {
    // readOnly is who-may-write: access, so it stays in the database (the rules read it).
    settingsFields: [],
    settingsFile: 'settings',
    subtrees: { db: { secret: false } },
  },
};

export const MANIFEST = '.tm-entity';
const KINDS = Object.keys(ENTITY_SPECS) as EntityKind[];
const isKind = (s: string | undefined): s is EntityKind => !!s && (KINDS as string[]).includes(s);

/** A routed document that is not a ticket. */
export type EntityLoc =
  /** The entity's own document: settings fields split off to Drive. */
  | { t: 'entity'; kind: EntityKind; id: string }
  /** A document in one of its subtrees. `rel` = its path under the entity. */
  | { t: 'file'; kind: EntityKind; id: string; rel: string[]; secret: boolean };

export function entityLoc(path: string): EntityLoc | null {
  const s = path.split('/');
  if (!isKind(s[0]) || !s[1]) return null;
  if (s.length === 2) return { t: 'entity', kind: s[0], id: s[1] };
  if (s.length % 2 !== 0) return null;
  const sub = ENTITY_SPECS[s[0]].subtrees[s[2]!];
  if (!sub || (sub.depth && s.length - 2 > sub.depth)) return null;
  return { t: 'file', kind: s[0], id: s[1], rel: s.slice(2), secret: sub.secret };
}

/** A routed collection that is not tickets: a subtree folder, or the entity collection itself. */
export type EntityColLoc =
  | { t: 'files'; kind: EntityKind; id: string; rel: string[]; secret: boolean }
  | { t: 'entities'; kind: EntityKind };

export function entityColLoc(path: string): EntityColLoc | null {
  const s = path.split('/');
  if (!isKind(s[0])) return null;
  if (s.length === 1) return { t: 'entities', kind: s[0] };
  if (s.length % 2 !== 1 || s.length < 3) return null;
  const sub = ENTITY_SPECS[s[0]].subtrees[s[2]!];
  if (!sub || (sub.depth && s.length - 2 > sub.depth)) return null;
  return { t: 'files', kind: s[0], id: s[1]!, rel: s.slice(2), secret: sub.secret };
}

/** The rev key of a routed document (driveRev/{key}). */
export const entityRevKey = (l: EntityLoc): string =>
  l.t === 'entity' ? '_entity' : l.rel.join('~');

/** Split a plain object's top-level fields: [settings, the rest]. */
export function splitFields(
  kind: EntityKind,
  data: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] {
  const keep = new Set(ENTITY_SPECS[kind].settingsFields);
  const drive: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) (keep.has(k) ? drive : rest)[k] = v;
  return [drive, rest];
}
