import { routes } from '$lib/layout/routes';

/**
 * Agent screens' URLs (agents.html §B); list/agent delegate to lib/layout/routes.
 * The SPA has no base path. (§AA5: an agent's token is made on the agent's own
 * page now, so there is no "new token for this agent" link into Account › Tokens.)
 */
export const agentRoutes = {
  list: routes.agents,
  agent: routes.agent,
};
