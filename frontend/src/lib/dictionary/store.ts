/**
 * DICTIONARY as the app reads it (docs/plan/dictionary.html): live Firestore
 * listeners (shared and ref-counted like every store in $lib/stores) and the
 * pure helpers the sidebar, the owner page, ⌘K, settings and the entries
 * editor use.
 *
 * Reads are direct for the dictionary's own people (the rules let anyone in
 * `memberUids` read the document and its content); every WRITE is a command.
 * Someone who reaches one only through a board grant reads it with
 * dictionaryGet instead (EntriesEditor falls back to it).
 */
import type { Readable } from 'svelte/store';
import {
  DICTIONARY_KEY_MAX,
  DICTIONARY_KEY_RE,
  dictionaryCan,
  dictionaryReach,
  paths,
  type Dictionary,
  type DictionaryContent,
  type DictionaryReach,
  type DictionaryRole,
} from '@tm/shared';
import { docStore, queryStore, type DocState, type QueryState, type WithId } from '$lib/stores';

/** Every dictionary I have a role on (archived included — see splitDictionaries). */
export function myDictionaries(uid: string | null | undefined): Readable<QueryState<Dictionary>> {
  return queryStore<Dictionary>(
    uid ? { path: paths.dictionaries(), where: [['memberUids', 'array-contains', uid]] } : null,
  );
}

/** One dictionary, live. permission-denied means "not shared with me" (or no longer). */
export function dictionaryDoc(id: string | null | undefined): Readable<DocState<Dictionary>> {
  return docStore<Dictionary>(id ? paths.dictionary(id) : null);
}

/** Its entries, live (one document beside it; missing until the first save). */
export function dictionaryContent(
  id: string | null | undefined,
): Readable<DocState<DictionaryContent>> {
  return docStore<DictionaryContent>(id ? paths.dictionaryContent(id) : null);
}

// ── pure ─────────────────────────────────────────────────────────────────────

export function dictionaryRoleIn(
  d: Pick<Dictionary, 'access'> | null | undefined,
  uid: string | null | undefined,
): DictionaryRole | null {
  return (uid && d?.access?.[uid]) || null;
}

/** What I may do here as a direct member (board grants are reached through the API). */
export function myDictionaryReach(
  d: Pick<Dictionary, 'access' | 'boards' | 'archivedAt'> | null | undefined,
  uid: string | null | undefined,
): DictionaryReach {
  return d ? dictionaryReach(d, { uid }) : null;
}

export const canWriteDictionary = (r: DictionaryReach): boolean => dictionaryCan.write(r);
export const canManageDictionary = (r: DictionaryReach): boolean => dictionaryCan.manage(r);

/** The ones I OWN — the only ones I may grant to a board, an artifact or an agent. */
export function ownedDictionaries<T extends Pick<Dictionary, 'access' | 'name'>>(
  list: readonly T[],
  uid: string | null | undefined,
): T[] {
  return list
    .filter((d) => uid && d.access?.[uid] === 'owner')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function splitDictionaries<T extends Pick<Dictionary, 'name' | 'archivedAt'>>(
  list: readonly T[],
): { active: T[]; archived: T[] } {
  return {
    active: list.filter((d) => d.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
    archived: list
      .filter((d) => d.archivedAt != null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

export const DICTIONARY_SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', owner: true },
  { id: 'people', label: 'People', owner: true },
  /** lib/access: the boards, artifacts and agents that use it. */
  { id: 'subscribers', label: 'Subscribers', owner: false },
  /** bucket.html §L4: this app ⇄ a folder of Google Drive (its owner moves it). */
  { id: 'storage', label: 'Storage', owner: false },
] as const;
export type DictionarySettingsSection = (typeof DICTIONARY_SETTINGS_SECTIONS)[number]['id'];

/** The owner sees all; an editor or viewer only Subscribers. */
export function dictionarySettingsFor(
  role: DictionaryRole | null,
): readonly { id: DictionarySettingsSection; label: string }[] {
  if (role === 'owner') return DICTIONARY_SETTINGS_SECTIONS;
  if (role) return DICTIONARY_SETTINGS_SECTIONS.filter((s) => !s.owner);
  return [];
}

/** People on it: owner, editors, viewers. */
export function dictionaryAccessRows(
  d: Pick<Dictionary, 'access'>,
): { uid: string; role: DictionaryRole }[] {
  const order: Record<DictionaryRole, number> = { owner: 0, editor: 1, viewer: 2 };
  return Object.entries(d.access)
    .map(([uid, role]) => ({ uid, role }))
    .sort((x, y) => order[x.role] - order[y.role] || x.uid.localeCompare(y.uid));
}

// ── the entries editor's rows ────────────────────────────────────────────────

/** Text: the value is a JSON string, typed as-is. JSON: any JSON value, typed as JSON. */
export type EntryType = 'text' | 'json';

export interface EntryRow {
  /** Local only: a stable {#each} key. */
  rid: string;
  key: string;
  type: EntryType;
  /** What the person types: the string itself (text) or JSON source (json). */
  text: string;
}

let ridSeq = 0;
export const newRid = (): string => `r${++ridSeq}`;

/** A stored value → a row: strings are Text, everything else JSON (pretty when it is an object). */
export function rowOf(key: string, value: unknown): EntryRow {
  if (typeof value === 'string') return { rid: newRid(), key, type: 'text', text: value };
  const pretty =
    value !== null && typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : JSON.stringify(value);
  return { rid: newRid(), key, type: 'json', text: pretty ?? 'null' };
}

/** Stored entries ({k, v: JSON text}) → API entries → rows. */
export function rowsOf(entries: readonly { key: string; value?: unknown }[]): EntryRow[] {
  return entries.map((e) => rowOf(e.key, e.value));
}

/** Switch a row's type, keeping what it means where it can. */
export function retype(row: EntryRow, type: EntryType): EntryRow {
  if (row.type === type) return row;
  if (type === 'json') {
    // "hello" as JSON is the string itself, quoted.
    return { ...row, type, text: JSON.stringify(row.text) };
  }
  // JSON → Text: a JSON string becomes its contents; anything else stays its source.
  try {
    const v = JSON.parse(row.text) as unknown;
    return { ...row, type, text: typeof v === 'string' ? v : row.text };
  } catch {
    return { ...row, type, text: row.text };
  }
}

/** The value a row stands for, or the reason it is not valid JSON. */
export function valueOf(
  row: EntryRow,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (row.type === 'text') return { ok: true, value: row.text };
  if (!row.text.trim())
    return { ok: false, error: 'Empty — type a JSON value (e.g. 42, true, {…})' };
  try {
    return { ok: true, value: JSON.parse(row.text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not valid JSON' };
  }
}

/** Why a key is not allowed (empty, bad characters, a duplicate) — or null. */
export function keyError(key: string, dupes: ReadonlySet<string>): string | null {
  if (!key) return 'A key is required';
  if (key.length > DICTIONARY_KEY_MAX) return `At most ${DICTIONARY_KEY_MAX} characters`;
  if (!DICTIONARY_KEY_RE.test(key))
    return 'Letters, digits and _ . : - only; not starting with . : -';
  if (dupes.has(key)) return 'This key is there twice';
  return null;
}

/** The keys that appear more than once. */
export function duplicateKeys(rows: readonly Pick<EntryRow, 'key'>[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) dup.add(r.key);
    seen.add(r.key);
  }
  return dup;
}

/** Rows → what dictionarySet { replace } takes; null when any row is invalid. */
export function replaceOf(rows: readonly EntryRow[]): { key: string; value: unknown }[] | null {
  const dupes = duplicateKeys(rows);
  const out: { key: string; value: unknown }[] = [];
  for (const r of rows) {
    if (keyError(r.key, dupes)) return null;
    const v = valueOf(r);
    if (!v.ok) return null;
    out.push({ key: r.key, value: v.value });
  }
  return out;
}

/** A comparable fingerprint of rows (dirty check), ignoring the local ids. */
export function rowsSignature(rows: readonly EntryRow[]): string {
  return JSON.stringify(rows.map((r) => [r.key, r.type, r.text]));
}

/** Move one row up (-1) or down (+1). */
export function moveRow<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export type { WithId };
