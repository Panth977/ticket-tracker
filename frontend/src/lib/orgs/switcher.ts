/**
 * The title dropdown on a board (BoardBar), an artifact (ArtifactHost), a
 * bucket and a dictionary: one list, built here so they never drift (agents.html §AC).
 *
 *   the open item belongs to an org I am in → that org's boards, then its
 *                                              artifacts, its buckets, then
 *                                              its dictionaries
 *   otherwise                               → every board (on a board), every
 *                                              artifact (on an artifact), every
 *                                              bucket (on a bucket) or every
 *                                              dictionary (on a dictionary)
 *
 * Archived ones are left out; the open one is marked (disabled). Every row
 * carries its entity's indicator (indicators.html), drawn by Menu.
 */
import {
  BUCKET_DEFAULT_INDICATOR,
  DICTIONARY_DEFAULT_INDICATOR,
  type Artifact,
  type Board,
  type Bucket,
  type Dictionary,
  type Org,
} from '@tm/shared';
import { routes } from '$lib/layout/routes';
import type { WithId } from '$lib/stores';
import type { MenuItem } from '$lib/ui/types';

export type Current =
  { boardId: string } | { artifactId: string } | { bucketId: string } | { dictionaryId: string };

interface Things {
  boards: readonly WithId<Board>[];
  artifacts: readonly WithId<Artifact>[];
  buckets?: readonly WithId<Bucket>[];
  dictionaries?: readonly WithId<Dictionary>[];
}

/** The org that owns the open item, when I am in it — else null. */
export function ownerOrg(
  orgs: readonly WithId<Org>[],
  t: Things,
  current: Current,
): WithId<Org> | null {
  const item =
    'boardId' in current
      ? t.boards.find((b) => b.id === current.boardId)
      : 'artifactId' in current
        ? t.artifacts.find((a) => a.id === current.artifactId)
        : 'bucketId' in current
          ? (t.buckets ?? []).find((m) => m.id === current.bucketId)
          : (t.dictionaries ?? []).find((d) => d.id === current.dictionaryId);
  const key = item?.ownerKey;
  return key?.startsWith('org:') ? (orgs.find((o) => `org:${o.id}` === key) ?? null) : null;
}

export function switcherItems(
  o: Things & { org: WithId<Org> | null; current: Current },
): MenuItem[] {
  const inOrg = <T extends { ownerKey?: string | null }>(x: T) =>
    !o.org || x.ownerKey === `org:${o.org.id}`;
  const boards = o.boards.filter((b) => b.archivedAt == null && inOrg(b));
  const artifacts = o.artifacts.filter((a) => a.archivedAt == null && inOrg(a));
  const buckets = (o.buckets ?? []).filter((m) => m.archivedAt == null && inOrg(m));
  const dictionaries = (o.dictionaries ?? []).filter((d) => d.archivedAt == null && inOrg(d));
  const boardItem = (b: WithId<Board>, separator = false): MenuItem => ({
    label: `${b.key} · ${b.name}`,
    indicator: { of: b, seed: b.id },
    href: routes.board(b.key),
    disabled: 'boardId' in o.current && b.id === o.current.boardId,
    separator,
  });
  const artifactItem = (a: WithId<Artifact>, separator = false): MenuItem => ({
    label: a.name,
    indicator: { of: a, seed: a.id },
    href: routes.artifact(a.id),
    disabled: 'artifactId' in o.current && a.id === o.current.artifactId,
    separator,
  });
  const bucketItem = (m: WithId<Bucket>, separator = false): MenuItem => ({
    label: m.name,
    indicator: { of: m, seed: m.id, fallback: BUCKET_DEFAULT_INDICATOR },
    href: routes.bucket(m.id),
    disabled: 'bucketId' in o.current && m.id === o.current.bucketId,
    separator,
  });
  const dictionaryItem = (d: WithId<Dictionary>, separator = false): MenuItem => ({
    label: d.name,
    indicator: { of: d, seed: d.id, fallback: DICTIONARY_DEFAULT_INDICATOR },
    href: routes.dictionary(d.id),
    disabled: 'dictionaryId' in o.current && d.id === o.current.dictionaryId,
    separator,
  });
  const byName = <T extends { name: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => a.name.localeCompare(b.name));

  if (!o.org) {
    if ('boardId' in o.current) return byName(boards).map((b) => boardItem(b));
    if ('artifactId' in o.current) return byName(artifacts).map((a) => artifactItem(a));
    if ('bucketId' in o.current) return byName(buckets).map((m) => bucketItem(m));
    return byName(dictionaries).map((d) => dictionaryItem(d));
  }
  const bs = byName(boards);
  const as = byName(artifacts);
  const ms = byName(buckets);
  return [
    ...bs.map((x) => boardItem(x)),
    ...as.map((x, i) => artifactItem(x, i === 0 && bs.length > 0)),
    ...ms.map((x, i) => bucketItem(x, i === 0 && bs.length + as.length > 0)),
    ...byName(dictionaries).map((x, i) =>
      dictionaryItem(x, i === 0 && bs.length + as.length + ms.length > 0),
    ),
  ];
}
