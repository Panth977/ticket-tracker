## 5. Reference

> Everything in this section is **generated** — from the OpenAPI document the REST routes are built
> from, the MCP tool registry, the shared contract module, and the SDK's published declaration file.
> Nothing here is hand-written, so nothing here can be out of date.

### 5.1 Scopes, events, errors and vocabularies

{{gen:contracts}}

### 5.2 REST — every endpoint

Root `{{url:apiBase}}`. `Authorization: Bearer tm_live_…` on every request. Tickets are addressed by
**key** (`ENG-42`); `{KEY}` below is that key, URL-encoded. Every write takes an `Idempotency-Key`
header. Every failure is `application/problem+json` (§5.1). Machine-readable:
`{{url:openapiUrl}}`.

{{gen:rest}}

### 5.3 MCP — every tool

Endpoint `{{url:mcpUrl}}` (Streamable HTTP). The same token, as a Bearer header. A tool whose scopes
the credential does not hold is **not listed** and is refused if called. `board` is only needed by
credentials that span several boards — a board-scoped token implies its board.

{{gen:mcp}}

### 5.4 SDK — every method

{{gen:sdk}}

#### Building your own MCP server from the SDK

Rather than handing an agent the whole MCP endpoint, build the tool list you want:

```ts
import { createClient, mcpTools, registerTools } from '{{url:sdk.ts}}';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const tm = createClient({ token: process.env.TM_TOKEN! });

const tools = await mcpTools(tm, {
  only: ['get_ticket', 'post_message', 'set_tasklist', 'update_task_item', 'ask_question', 'heartbeat'],
  rename: { post_message: 'reply' },
  describe: { reply: 'Reply to the ticket you are working on. Markdown.' },
  defaults: { ticket: 'ENG-42' },     // fixed arguments the model never passes, and cannot change
});

await registerTools(new McpServer({ name: 'my-orch', version: '1' }), tools);
```

`mcpTools()` returns plain `{ name, description, inputSchema, handler, scopes, readOnly }` definitions, so they work with
any MCP implementation. Tools the token's scopes already forbid are dropped, so the model is never
offered a call that must fail — and the server checks again anyway.
