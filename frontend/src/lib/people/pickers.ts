/**
 * Picker sources over a board's members — people AND agents (agents.html §D:
 * "The assignee picker and the @ menu list people and agents on the board.
 * Agents are marked with their badge."). The members/ collection already holds
 * agent rows (kind 'agent'), so these only order, match and label them.
 */
import type { BoardMember } from '@tm/shared';
import { avatarUrl } from './person';
import { isAgentId, matchPrincipals, sortPrincipals } from './principal';

type Member = Pick<BoardMember, 'uid' | 'name' | 'email' | 'avatarPath'> &
  Partial<Pick<BoardMember, 'kind' | 'description' | 'icon'>>;

const isAgent = (m: Member) => m.kind === 'agent' || isAgentId(m.uid);

/** For ChoicePicker-style pickers: { id, label, uid, search, agent }. */
export function principalChoices(members: readonly Member[]) {
  return sortPrincipals(members).map((m) => ({
    id: m.uid,
    label: m.name || m.email,
    uid: m.uid,
    search: isAgent(m) ? `agent bot ${m.description ?? ''}` : m.email,
    agent: isAgent(m),
  }));
}

/** An @-menu row (shape of $lib/editor SuggestItem, plus `agent`). */
export interface PrincipalSuggestItem {
  id: string;
  kind: 'person';
  uid: string;
  label: string;
  detail?: string;
  avatarUrl: string | null;
  /** Agents: the prebuilt icon id, drawn when there is no picture. */
  icon: string | null;
  agent: boolean;
}

/** The @ menu's source: matches people and agents; agents' detail reads 'Agent · description'. */
export async function principalSuggestItems(
  members: readonly Member[],
  query: string,
  max = 8,
): Promise<PrincipalSuggestItem[]> {
  const top = matchPrincipals(query, members).slice(0, max);
  const urls = await Promise.all(top.map((m) => avatarUrl(m.avatarPath)));
  return top.map((m, i) => {
    const agent = isAgent(m);
    return {
      id: m.uid,
      kind: 'person' as const,
      uid: m.uid,
      label: m.name || m.email,
      detail: agent ? ['Agent', m.description].filter(Boolean).join(' · ') : m.email,
      avatarUrl: urls[i] ?? null,
      icon: agent ? (m.icon ?? null) : null,
      agent,
    };
  });
}
