/**
 * The OAuth consent screen's plain-words view of the ONE scope vocabulary
 * (@tm/shared SCOPES, agents.html §E). People see a few plain choices; each maps
 * to scopes, which only ever NARROW what the person's own board roles allow.
 * Personal tokens use the granular checkboxes instead (./tokens).
 */
import { normalizeScopes, SCOPES, type Scope } from '@tm/shared';

export interface ScopeGroup {
  id: 'read' | 'write' | 'comment' | 'plan' | 'webhooks' | 'boards' | 'agents' | 'artifacts';
  label: string;
  hint: string;
  scopes: Scope[];
}

export const SCOPE_GROUPS: ScopeGroup[] = [
  {
    id: 'read',
    label: 'Can read tickets',
    hint: 'Boards, tickets, threads, files and people on them',
    scopes: [
      'board:read',
      'members:read',
      'tickets:read',
      'comments:read',
      'files:read',
      'events:read',
    ],
  },
  {
    id: 'write',
    label: 'Can create and edit tickets',
    hint: 'Create, edit, move, assign and close tickets',
    scopes: ['tickets:create', 'tickets:update', 'tickets:move', 'tickets:assign', 'tickets:state'],
  },
  {
    id: 'comment',
    label: 'Can comment',
    hint: 'Post in threads and upload files as you',
    scopes: ['comments:write', 'files:write'],
  },
  {
    id: 'plan',
    label: 'Can plan and report',
    hint: 'Ask questions in threads, keep task lists, say what it is working on',
    scopes: ['questions:write', 'tasklists:write', 'status:write'],
  },
  {
    id: 'webhooks',
    label: 'Can manage the board',
    hint: 'Settings and webhooks, on boards where you are an admin',
    scopes: ['board:admin', 'webhooks:manage'],
  },
  {
    id: 'boards',
    label: 'Can create boards and invite people',
    hint: 'New boards, and settings and people on boards where you are an admin',
    scopes: ['boards:create', 'boards:admin', 'invites:write'],
  },
  {
    id: 'agents',
    label: 'Can manage your agents',
    hint: 'Create and edit your agents, and put them on boards',
    scopes: ['agents:write'],
  },
  {
    id: 'artifacts',
    label: 'Can read and publish artifacts',
    hint: 'Read, create, publish and share artifacts',
    scopes: ['artifacts:read', 'artifacts:write'],
  },
];

/**
 * 'tickets:read  comments:write bogus' → known scopes only, de-duplicated, in
 * vocabulary order. Phase-1 names ('tickets:write', 'boards:read') are expanded
 * to the new ones, so older MCP clients keep working.
 */
export function parseScopeParam(param: string | null | undefined): Scope[] {
  return normalizeScopes((param ?? '').split(/[\s+,]+/).filter(Boolean)).scopes;
}

/** Groups that intersect the requested scopes (what the consent screen lists). */
export function groupsFor(requested: readonly Scope[]): ScopeGroup[] {
  return SCOPE_GROUPS.filter((g) => g.scopes.some((s) => requested.includes(s)));
}

/**
 * The scopes granted when these groups are ticked: only scopes that were
 * requested — consent can narrow a request, never widen it.
 */
export function scopesFromGroups(
  groupIds: readonly string[],
  requested?: readonly Scope[],
): Scope[] {
  const on = new Set(SCOPE_GROUPS.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.scopes));
  return SCOPES.filter((s) => on.has(s) && (!requested || requested.includes(s)));
}

/** Short summary for a list row: 'Read tickets · Comment'. */
export function describeScopes(scopes: readonly Scope[]): string {
  const groups = SCOPE_GROUPS.filter((g) => g.scopes.some((s) => scopes.includes(s)));
  return groups
    .map((g) => g.label.replace(/^Can /, '').replace(/^./, (c) => c.toUpperCase()))
    .join(' · ');
}
