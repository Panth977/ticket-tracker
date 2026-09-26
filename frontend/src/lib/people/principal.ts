/**
 * PRINCIPALS (docs/plan/agents.html §A) — pure helpers, no Firebase.
 *
 * Anyone who can appear on a ticket is a principal: a person (Firebase uid) or
 * an agent ('ag_' + 16). Both live in the same fields (assigneeUids, mentions,
 * members/{id}, authorUid …); the id's prefix tells them apart. The UI draws
 * every principal with ONE shape — `Person` in ./person — and marks agents with
 * a badge; these helpers build that shape from whatever source we have.
 */
import { isAgentId, type Agent, type BoardMember, type PrincipalKind } from '@tm/shared';

export { isAgentId };

/** The display shape for a person OR an agent (see ./person for the live store). */
export interface Person {
  uid: string;
  kind: PrincipalKind;
  name: string;
  /** '' for agents. */
  email: string;
  /** Resolved download URL, or null (no picture / still resolving). */
  avatarUrl: string | null;
  /** Agents only: a prebuilt icon id (shared AGENT_ICON_IDS), shown when there is no picture. */
  icon?: string | null;
  /** accountDelete soft-deleted this person / the agent is archived. */
  deleted: boolean;
  /** Agents only: the person who owns the profile. */
  ownerUid?: string | null;
  /** Agents only: the one-line description shown in pickers. */
  description?: string | null;
}

type AgentSource = Pick<Agent, 'name' | 'ownerUid' | 'description'> & {
  archivedAt?: number | null;
  icon?: string | null;
};
type MemberSource = Pick<BoardMember, 'uid' | 'name' | 'email'> &
  Partial<Pick<BoardMember, 'kind' | 'ownerUid' | 'description' | 'icon'>>;

/** An agent's profile (agents/{id}, owner only) → Person. */
export function agentToPerson(id: string, a: AgentSource, url: string | null): Person {
  return {
    uid: id,
    kind: 'agent',
    name: a.name || 'Agent',
    email: '',
    avatarUrl: url,
    icon: a.icon ?? null,
    deleted: a.archivedAt != null,
    ownerUid: a.ownerUid,
    description: a.description ?? null,
  };
}

/** A board member row (people AND agents, denormalised) → Person. */
export function memberToPerson(m: MemberSource, url: string | null): Person {
  const agent = m.kind === 'agent' || isAgentId(m.uid);
  return {
    uid: m.uid,
    kind: agent ? 'agent' : 'user',
    name: m.name || m.email || (agent ? 'Agent' : 'Unknown'),
    email: agent ? '' : m.email,
    avatarUrl: url,
    deleted: false,
    ...(agent
      ? { icon: m.icon ?? null, ownerUid: m.ownerUid ?? null, description: m.description ?? null }
      : {}),
  };
}

/** What we show when an agent can't be looked up (not ours, no shared board). */
export function unknownAgent(id: string): Person {
  return {
    uid: id,
    kind: 'agent',
    name: 'Agent',
    email: '',
    avatarUrl: null,
    icon: null,
    deleted: false,
    ownerUid: null,
    description: null,
  };
}

/** 'Priya Shah' / 'Builder (agent)' — plain text for titles, toasts and aria labels. */
export function principalLabel(p: Pick<Person, 'name' | 'kind'> | null | undefined): string {
  if (!p) return 'Someone';
  return p.kind === 'agent' ? `${p.name} (agent)` : p.name;
}

/** The second line under a name: the email for a person, the description for an agent. */
export function principalDetail(p: Pick<Person, 'kind' | 'email' | 'description'>): string {
  return p.kind === 'agent' ? (p.description ?? '') : p.email;
}

type Sortable = Pick<BoardMember, 'uid' | 'name' | 'email'> & { kind?: PrincipalKind };
const kindOf = (m: Sortable): PrincipalKind =>
  m.kind === 'agent' || isAgentId(m.uid) ? 'agent' : 'user';
const nameOf = (m: Sortable) => (m.name || m.email || '').toLowerCase();

/** People first, then agents; each by name. What every picker lists. */
export function sortPrincipals<T extends Sortable>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(kindOf(a) === 'agent') - Number(kindOf(b) === 'agent') ||
      nameOf(a).localeCompare(nameOf(b)),
  );
}

/**
 * The assignee picker's / @ menu's matcher over a board's members (people AND
 * agents): prefix matches on a name word or the email first, then substring
 * matches; the word 'agent' (or 'bot') finds every agent.
 */
export function matchPrincipals<T extends Sortable & { description?: string | null }>(
  query: string,
  list: readonly T[],
): T[] {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  if (!q) return sortPrincipals(list);
  const score = (m: T): number => {
    const name = nameOf(m);
    const email = (m.email || '').toLowerCase();
    if (kindOf(m) === 'agent' && ('agent'.startsWith(q) || 'bot'.startsWith(q))) return 3;
    if (name.startsWith(q) || email.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q) || email.includes(q) || (m.description ?? '').toLowerCase().includes(q))
      return 2;
    return -1;
  };
  return sortPrincipals(list)
    .map((m) => [m, score(m)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([m]) => m);
}
