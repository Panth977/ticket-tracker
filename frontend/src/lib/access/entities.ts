/**
 * How a board / artifact / memory / agent appears in a Subscriptions or
 * Subscribers row and in the Add dialog's list: its mark, its name (or
 * "A board you are not on" when the viewer cannot open it), where it links.
 */
import {
  MEMORY_DEFAULT_INDICATOR,
  memoryAppPath,
  type Board,
  type Indicator,
  type Memory,
  type Stage,
} from '@tm/shared';
import { agentRoutes } from '$lib/agents/routes';
import { routes } from '$lib/layout/routes';
import type { Allowed, EntityKind, PermLocks, Perms, Relation } from './relations';

export interface EntityView {
  kind: EntityKind;
  id: string;
  /** null = the viewer cannot open it: the row says HIDDEN_LABEL[kind]. */
  name: string | null;
  /** A board's key, drawn before the name. */
  key?: string;
  href?: string;
  /** What Indicator draws (agents draw their avatar instead). */
  mark?: {
    of?: { indicator?: Indicator | null; color?: string | null; icon?: string | null } | null;
    indicator?: Indicator | null;
    seed: string;
    fallback?: Indicator;
  };
  /** A second line: "archived", "3 files"… */
  note?: string;
  /** A board's stages — the agent stage-grant step needs them. */
  stages?: Stage[];
}

type BoardLike = Pick<Board, 'name' | 'key' | 'archivedAt'> &
  Partial<Pick<Board, 'stages' | 'indicator' | 'color'>> & { id: string };

export const boardView = (b: BoardLike): EntityView => ({
  kind: 'board',
  id: b.id,
  name: b.name,
  key: b.key,
  href: routes.board(b.key),
  mark: { of: b, seed: b.id },
  note: b.archivedAt != null ? 'archived' : undefined,
  stages: b.stages,
});

type ArtifactLike = {
  id: string;
  name: string;
  archivedAt?: number | null;
  indicator?: Indicator | null;
  icon?: string | null;
};
export const artifactView = (a: ArtifactLike): EntityView => ({
  kind: 'artifact',
  id: a.id,
  name: a.name,
  href: routes.artifact(a.id),
  mark: { of: a, seed: a.id },
  note: a.archivedAt != null ? 'archived' : undefined,
});

type MemoryLike = Pick<Memory, 'name'> & {
  id: string;
  archivedAt?: number | null;
  archived?: boolean;
  indicator?: Indicator | null;
  icon?: string | null;
  stats?: { files: number };
};
export const memoryView = (m: MemoryLike): EntityView => ({
  kind: 'memory',
  id: m.id,
  name: m.name,
  href: memoryAppPath(m.id),
  mark: { of: m, seed: m.id, fallback: MEMORY_DEFAULT_INDICATOR },
  note:
    m.archivedAt != null || m.archived
      ? 'archived'
      : m.stats
        ? `${m.stats.files} ${m.stats.files === 1 ? 'file' : 'files'}`
        : undefined,
});

export const agentView = (a: { id: string; name: string | null; mine?: boolean }): EntityView => ({
  kind: 'agent',
  id: a.id,
  name: a.name,
  href: a.mine ? agentRoutes.agent(a.id) : undefined,
});

/** An entity the viewer cannot open: only its kind and id are known. */
export const hiddenView = (
  kind: EntityKind,
  id: string,
  mark?: EntityView['mark'],
): EntityView => ({
  kind,
  id,
  name: null,
  mark,
});

/** One thing the Add dialog offers. */
export interface Candidate {
  entity: EntityView;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one list mixes relations
  relation: Relation<any>;
  /** Why it cannot be chosen (shown, and the row is disabled). */
  disabled?: string;
  /** Boxes that cannot be ticked for this one, with why. */
  locks?: PermLocks;
}

/** …and one already there, being edited. */
export interface Editing extends Candidate {
  perms: Perms;
}

/** A Subscriptions row: what this entity uses, with which permissions. */
export interface SubscriptionRow extends Editing {
  /** true, or why Edit is disabled. Relations without permissions never edit. */
  edit: Allowed;
  /** true, or why Remove is disabled. */
  remove: Allowed;
}

/** A Subscribers row: who uses this entity. Remove only. */
export interface SubscriberRow {
  entity: EntityView;
  chips: string[];
  remove: Allowed;
}
