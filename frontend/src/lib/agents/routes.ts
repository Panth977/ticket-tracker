import { routes } from '$lib/layout/routes';

/**
 * Agent screens' URLs (agents.html §B); list/agent delegate to lib/layout/routes.
 * The SPA has no base path.
 */
export const agentRoutes = {
  list: routes.agents,
  agent: routes.agent,
  /** Account › Tokens with the New token form open, prefilled. */
  newToken: (o: { boardId?: string | null; agentId?: string | null } = {}) => {
    const q = new URLSearchParams({ new: '1' });
    if (o.boardId) q.set('board', o.boardId);
    if (o.agentId) q.set('agent', o.agentId);
    return `/account/tokens?${q}`;
  },
};
