/**
 * ACCESS BETWEEN THINGS — one vocabulary for every place one entity lets
 * another use it (memory.html §D, artifacts.html §K, agents.html §AA2–§AA3,
 * §AB). Each entity shows the same two lists:
 *
 *   Subscriptions   what THIS entity uses, and with which permissions —
 *                   Add (pick → tick permissions → Add), Edit, Remove
 *   Subscribers     who uses THIS entity — Remove only
 *
 * A RELATION is one kind of link (a board using a memory, an agent on a
 * board…). It says which permissions there are as checkboxes, what each one
 * implies, how the ticked set becomes the stored value and back, and how a
 * row reads as chips. Nothing here talks to the API: the sections that use
 * these call the commands themselves, and the server stays the judge of who
 * may do what (the `can*` mirrors below only grey out what it would refuse).
 */
import {
  agentAccessOf,
  type AgentBoardRole,
  type ArtifactAgentAccess,
  type ArtifactBoardAccess,
  type MemoryGrant,
  type Stage,
  type StageGrant,
} from '@tm/shared';

export type EntityKind = 'board' | 'artifact' | 'memory' | 'agent';

export const KIND_LABEL: Record<EntityKind, string> = {
  board: 'Board',
  artifact: 'Artifact',
  memory: 'Memory',
  agent: 'Agent',
};
/** "A board you are not on" — what a row says for an entity the viewer cannot open. */
export const HIDDEN_LABEL: Record<EntityKind, string> = {
  board: 'A board you are not on',
  artifact: 'An artifact not shared with you',
  memory: 'A memory not shared with you',
  agent: 'Someone else’s agent',
};

/** One checkbox in step 2 of the Add dialog. */
export interface PermDef {
  key: string;
  label: string;
  hint: string;
  /** Ticking this ticks these too (transitively); unticking one of these unticks this. */
  requires?: readonly string[];
}

/** What the dialog edits: the ticked permissions, and a commenter's stage grant. */
export interface Perms {
  checks: readonly string[];
  stageGrant?: StageGrant | null;
}

export interface Relation<V> {
  id: RelationId;
  /** [] = no modes (a workspace just includes things): the dialog skips step 2. */
  perms: readonly PermDef[];
  /** The stored value → ticked boxes. null = not subscribed. */
  toPerms(value: V | null | undefined): Perms;
  /** Ticked boxes → the stored value; null = nothing ticked (not a valid subscription). */
  fromPerms(p: Perms): V | null;
  /** What a row shows. */
  chips(p: Perms, ctx?: { stages?: readonly Stage[] }): string[];
  /** A stage grant step for commenters (agent on a board). */
  stageGrant?: boolean;
  /** What step 2 starts with when adding. */
  initial: Perms;
}

export type RelationId =
  | 'board-memory'
  | 'artifact-memory'
  | 'artifact-board'
  | 'agent-board'
  | 'agent-artifact'
  | 'workspace';

// ───────────────────────────────────────────────────────────── implications

function closure(perms: readonly PermDef[], keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const add = (k: string) => {
    if (out.has(k)) return;
    const p = perms.find((x) => x.key === k);
    if (!p) return;
    out.add(k);
    for (const r of p.requires ?? []) add(r);
  };
  for (const k of keys) add(k);
  return out;
}

/** Tick or untick one box, keeping the implications: on ⇒ what it requires; off ⇒ what requires it. */
export function toggle(
  perms: readonly PermDef[],
  checks: readonly string[],
  key: string,
  on: boolean,
): string[] {
  let set: Set<string>;
  if (on) set = closure(perms, [...checks, key]);
  else {
    set = new Set(checks);
    set.delete(key);
    // Drop everything that (transitively) needs `key`.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of perms)
        if (set.has(p.key) && (p.requires ?? []).some((r) => !set.has(r))) {
          set.delete(p.key);
          changed = true;
        }
    }
  }
  return perms.filter((p) => set.has(p.key)).map((p) => p.key);
}

/** The ticked set made consistent (what a stored value or a hand-made list really means). */
export function normalize(perms: readonly PermDef[], checks: readonly string[]): string[] {
  const set = closure(perms, checks);
  return perms.filter((p) => set.has(p.key)).map((p) => p.key);
}

const has = (p: Perms, k: string) => p.checks.includes(k);
const labelsOf = (perms: readonly PermDef[], p: Perms) =>
  perms.filter((x) => has(p, x.key)).map((x) => x.label);

// ───────────────────────────────────────────────────────────── read / write

function readWrite<V extends 'read' | 'write'>(
  id: RelationId,
  hints: { read: string; write: string },
): Relation<V> {
  const perms: PermDef[] = [
    { key: 'read', label: 'Read', hint: hints.read },
    { key: 'write', label: 'Write', hint: hints.write, requires: ['read'] },
  ];
  return {
    id,
    perms,
    toPerms: (v) => ({ checks: v === 'write' ? ['read', 'write'] : v === 'read' ? ['read'] : [] }),
    fromPerms: (p) => {
      const c = normalize(perms, p.checks);
      return (c.includes('write') ? 'write' : c.includes('read') ? 'read' : null) as V | null;
    },
    chips: (p) => labelsOf(perms, { checks: normalize(perms, p.checks) }),
    initial: { checks: ['read'] },
  };
}

/** A board subscribes to a memory (memory.html §D). */
export const BOARD_MEMORY: Relation<MemoryGrant> = readWrite('board-memory', {
  read: 'Everyone on the board can browse it and attach its files to tickets',
  write: 'Editors and admins can also add and change files; ticket files can go into it',
});

/** An artifact subscribes to a memory (memory.html §D, §H). */
export const ARTIFACT_MEMORY: Relation<MemoryGrant> = readWrite('artifact-memory', {
  read: 'The page reads its files through BackendDriver.memory',
  write: 'The page can also add and change files',
});

/** An artifact subscribes to a board (artifacts.html §K). */
export const ARTIFACT_BOARD: Relation<ArtifactBoardAccess> = readWrite('artifact-board', {
  read: 'The page reads the board’s tickets through BackendDriver.tickets',
  write: 'The page can also change tickets (needs you to be an editor or admin there)',
});

// ───────────────────────────────────────────────────────────── agent on a board

/** Least to most; each box needs the one before it. The highest ticked IS the role (§AA2). */
const ROLE_PERMS: { key: string; role: AgentBoardRole; label: string; hint: string }[] = [
  {
    key: 'view',
    role: 'viewer',
    label: 'View',
    hint: 'Read the board, its tickets, threads and files',
  },
  {
    key: 'comment',
    role: 'commenter',
    label: 'Comment',
    hint: 'Comment, upload, ask and answer, heartbeat; move tickets only between the stages below',
  },
  {
    key: 'edit',
    role: 'editor',
    label: 'Edit',
    hint: 'Create, edit, move, assign, archive and task lists',
  },
  {
    key: 'admin',
    role: 'admin',
    label: 'Admin',
    hint: 'Board settings, stages, fields, webhooks, restore — never its people or agents',
  },
];
export const AGENT_ROLE_CHIP: Record<AgentBoardRole, string> = {
  viewer: 'Viewer',
  commenter: 'Commenter',
  editor: 'Editor',
  admin: 'Admin',
};

export interface AgentBoardValue {
  role: AgentBoardRole;
  stageGrant: StageGrant | null;
}

const agentBoardPerms: PermDef[] = ROLE_PERMS.map((r, i) => ({
  key: r.key,
  label: r.label,
  hint: r.hint,
  ...(i > 0 ? { requires: [ROLE_PERMS[i - 1]!.key] } : {}),
}));

export function stageGrantLabel(
  g: StageGrant | null | undefined,
  stages: readonly Stage[] = [],
): string {
  if (!g?.stages.length) return 'No stage moves';
  const names = g.stages.map((id) => stages.find((s) => s.id === id)?.name ?? '?');
  return `Stages: ${names.join(', ')}${g.assignedOnly ? ' (its tickets)' : ''}`;
}

export const AGENT_BOARD: Relation<AgentBoardValue> = {
  id: 'agent-board',
  perms: agentBoardPerms,
  stageGrant: true,
  toPerms: (v) => {
    if (!v) return { checks: [] };
    const i = ROLE_PERMS.findIndex((r) => r.role === v.role);
    return {
      checks: ROLE_PERMS.slice(0, Math.max(0, i) + 1).map((r) => r.key),
      stageGrant: v.role === 'commenter' ? (v.stageGrant ?? null) : null,
    };
  },
  fromPerms: (p) => {
    const c = normalize(agentBoardPerms, p.checks);
    const top = [...ROLE_PERMS].reverse().find((r) => c.includes(r.key));
    if (!top) return null;
    return { role: top.role, stageGrant: top.role === 'commenter' ? (p.stageGrant ?? null) : null };
  },
  chips: (p, ctx) => {
    const v = AGENT_BOARD.fromPerms(p);
    if (!v) return [];
    return [
      AGENT_ROLE_CHIP[v.role],
      ...(v.role === 'commenter' ? [stageGrantLabel(v.stageGrant, ctx?.stages)] : []),
    ];
  },
  initial: { checks: ['view', 'comment', 'edit'], stageGrant: null },
};

// ───────────────────────────────────────────────────────────── agent on an artifact

const agentArtifactPerms: PermDef[] = [
  { key: 'build', label: 'Build', hint: 'Publish builds, roll back and download the source' },
  {
    key: 'read',
    label: 'Read data',
    hint: 'Read the artifact’s database and files through the API',
  },
  {
    key: 'write',
    label: 'Write data',
    hint: 'Also write the artifact’s database and files',
    requires: ['read'],
  },
];

/** An agent subscribes to an artifact (agents.html §AA3): { build, data }. */
export const AGENT_ARTIFACT: Relation<ArtifactAgentAccess> = {
  id: 'agent-artifact',
  perms: agentArtifactPerms,
  toPerms: (v) => {
    const a = agentAccessOf(v ?? { build: false, data: 'none' });
    return {
      checks: [
        ...(a.build ? ['build'] : []),
        ...(a.data !== 'none' ? ['read'] : []),
        ...(a.data === 'write' ? ['write'] : []),
      ],
    };
  },
  fromPerms: (p) => {
    const c = normalize(agentArtifactPerms, p.checks);
    const v: ArtifactAgentAccess = {
      build: c.includes('build'),
      data: c.includes('write') ? 'write' : c.includes('read') ? 'read' : 'none',
    };
    return !v.build && v.data === 'none' ? null : v;
  },
  chips: (p) => labelsOf(agentArtifactPerms, { checks: normalize(agentArtifactPerms, p.checks) }),
  initial: { checks: ['build', 'read', 'write'] },
};

// ───────────────────────────────────────────────────────────── workspace

/** A workspace includes a board / artifact / memory: no modes, it grants nothing. */
export const WORKSPACE: Relation<true> = {
  id: 'workspace',
  perms: [],
  toPerms: () => ({ checks: [] }),
  fromPerms: () => true,
  chips: () => [],
  initial: { checks: [] },
};

// ───────────────────────────────────────────────────────────── who may (client mirror)

/**
 * The server's rules, mirrored to grey out what it would refuse. Each answer
 * is `true` or the reason it is not allowed (the tooltip). The server decides.
 */
export type Allowed = true | string;

export const can = {
  /** memoryGrantSet grant/change: the memory's owner, who is admin of the board. */
  grantMemoryToBoard: (o: { ownsMemory: boolean; boardAdmin: boolean }): Allowed =>
    !o.ownsMemory
      ? 'Only the memory’s owner can change what it grants'
      : !o.boardAdmin
        ? 'Only a board admin can choose the board’s memories'
        : true,
  /** memoryGrantSet null for a board: the memory's owner or a board admin. */
  revokeMemoryFromBoard: (o: { ownsMemory: boolean; boardAdmin: boolean }): Allowed =>
    o.ownsMemory || o.boardAdmin ? true : 'Only the memory’s owner or a board admin can remove it',
  /** memoryGrantSet grant/change for an artifact: memory owner who owns the artifact. */
  grantMemoryToArtifact: (o: { ownsMemory: boolean; ownsArtifact: boolean }): Allowed =>
    !o.ownsMemory
      ? 'Only the memory’s owner can change what it grants'
      : !o.ownsArtifact
        ? 'Only the artifact’s owner can choose its memories'
        : true,
  revokeMemoryFromArtifact: (o: { ownsMemory: boolean; ownsArtifact: boolean }): Allowed =>
    o.ownsMemory || o.ownsArtifact
      ? true
      : 'Only the memory’s owner or the artifact’s owner can remove it',
  /** artifactBoardAccessSet grant: the artifact's owner, on the board. */
  grantBoardToArtifact: (o: { ownsArtifact: boolean; onBoard: boolean }): Allowed =>
    !o.ownsArtifact
      ? 'Only the artifact’s owner can choose its boards'
      : !o.onBoard
        ? 'You are not on this board'
        : true,
  /** artifactBoardAccessSet null: the artifact's owner or a board admin. */
  revokeBoardFromArtifact: (o: { ownsArtifact: boolean; boardAdmin: boolean }): Allowed =>
    o.ownsArtifact || o.boardAdmin
      ? true
      : 'Only the artifact’s owner or a board admin can remove it',
  /** boardAgentSet add: a board admin who owns the agent. */
  addAgentToBoard: (o: { ownsAgent: boolean; boardAdmin: boolean }): Allowed =>
    !o.boardAdmin
      ? 'You are not an admin there'
      : !o.ownsAgent
        ? 'Only the agent’s owner can add it'
        : true,
  /** boardAgentSet change / remove: any board admin. */
  changeAgentOnBoard: (o: { boardAdmin: boolean }): Allowed =>
    o.boardAdmin ? true : 'Only a board admin can change this',
  /** artifactShare for an agent: the artifact's owner (who owns the agent). */
  agentOnArtifact: (o: { ownsArtifact: boolean }): Allowed =>
    o.ownsArtifact ? true : 'Only the artifact’s owner can change its agents',
};

/** A write box that cannot be ticked here (e.g. artifact → board write without editor/admin). */
export type PermLocks = Partial<Record<string, string>>;
