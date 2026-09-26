/**
 * What the token form shows ONCE after apiKeyCreate (agents.html §E): the
 * token plus a ready-to-paste MCP config and curl examples. Pure string
 * builders so the web UI and docs render the same thing.
 */

export interface TokenSnippetInput {
  /** The full 'tm_live_…' key. */
  key: string;
  /** e.g. 'https://api.taskmanager.app' — REST lives at {apiBase}/v1, MCP at {apiBase}/mcp. */
  apiBase: string;
  /** The MCP server name in the client config (default 'taskmanager'). */
  serverName?: string;
}

const trim = (u: string) => u.replace(/\/+$/, '');

/** `{ mcpServers: { taskmanager: { type: 'http', url, headers } } }` — Claude Code / Desktop / Cursor style. */
export function mcpClientConfig({ key, apiBase, serverName = 'taskmanager' }: TokenSnippetInput) {
  return {
    mcpServers: {
      [serverName]: {
        type: 'http' as const,
        url: `${trim(apiBase)}/mcp`,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
}

/** A few curl lines that exercise the token: who am I, my tickets, my events. */
export function curlExamples({ key, apiBase }: TokenSnippetInput): string[] {
  const b = `${trim(apiBase)}/v1`;
  const auth = `-H "Authorization: Bearer ${key}"`;
  return [
    `curl ${auth} ${b}/me`,
    `curl ${auth} "${b}/tickets?assignee=me"`,
    `curl ${auth} "${b}/events?limit=20"`,
    `curl ${auth} -H "Content-Type: application/json" -d '{"body_markdown":"Picked this up."}' ${b}/tickets/KEY-1/messages`,
  ];
}
