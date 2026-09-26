/**
 * Flow: "Connecting Claude over MCP" (platform/flows.json) with a real MCP
 * client (@modelcontextprotocol/sdk):
 *
 *   /mcp without a token → 401 + WWW-Authenticate naming the resource metadata
 *   discovery → dynamic client registration → /oauth/authorize (PKCE S256)
 *   → the SPA's consent screen, approved in the browser by the signed-in person
 *   → code → /oauth/token → MCP initialize, list tools, create_ticket
 *
 * The ticket is an ordinary one, made by that person via 'mcp'.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_URL, http, newBoard, newPerson, read } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const REDIRECT = 'http://127.0.0.1:5198/callback';

test('MCP: OAuth (DCR + PKCE + consent screen) then create_ticket through an MCP client', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'MCP board' });

  // 1. unauthenticated → 401 pointing at the protected-resource metadata
  const first = await http('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(first.status).toBe(401);
  expect(first.headers.get('www-authenticate')).toContain('oauth-protected-resource');

  const as = await http('/.well-known/oauth-authorization-server');
  expect(as.status).toBe(200);
  expect(as.body.code_challenge_methods_supported).toContain('S256');

  // 2. dynamic client registration (a public client, like Claude Desktop)
  const reg = await http('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'E2E Agent',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const clientId: string = reg.body.client_id;

  // 3. authorize with PKCE → the SPA consent screen
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(8).toString('hex');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'boards:read tickets:read tickets:write',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authz = await http(`/oauth/authorize?${q}`, { redirect: 'manual' });
  expect(authz.status).toBe(302);
  const consentUrl = new URL(authz.headers.get('location')!);
  expect(consentUrl.pathname).toBe('/oauth/consent');

  // 4. the person approves in the browser
  let redirected: URL | null = null;
  await page.route('http://127.0.0.1:5198/**', (route) => {
    redirected = new URL(route.request().url());
    return route.fulfill({ status: 200, body: 'ok' });
  });
  await signIn(page, ada.email, consentUrl.pathname + consentUrl.search);
  await expect(
    page.getByRole('heading', { name: /E2E Agent wants to use your TaskManager account/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => redirected?.searchParams.get('code') ?? null).not.toBeNull();
  expect(redirected!.searchParams.get('state')).toBe(state);

  // 5. code → tokens
  const tok = await http('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: redirected!.searchParams.get('code')!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  expect(tok.status, JSON.stringify(tok.body)).toBe(200);
  const accessToken: string = tok.body.access_token;
  expect(tok.body.refresh_token).toBeTruthy();

  // 6. a real MCP client over Streamable HTTP
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(['create_ticket', 'search_tickets', 'list_my_tickets']),
  );

  const res = await client.callTool({
    name: 'create_ticket',
    arguments: {
      board: b.key,
      title: 'Filed by an agent',
      description: 'Found while **triaging**',
      stage: 'To do',
      assignees: ['me'],
    },
  });
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
  const created = JSON.parse((res.content as { type: string; text: string }[])[0]!.text);
  expect(created).toMatchObject({
    key: `${b.key}-1`,
    title: 'Filed by an agent',
    stage: { name: 'To do' },
  });
  await client.close();

  const t = await read(`boards/${b.id}/tickets/${created.id}`);
  expect(t).toMatchObject({ title: 'Filed by an agent', createdBy: ada.uid });

  // a wrong stage name answers with the names that exist (a tool error, not a crash)
  const client2 = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client2.connect(
    new StreamableHTTPClientTransport(new URL(`${API_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const bad = await client2.callTool({
    name: 'create_ticket',
    arguments: { board: b.key, title: 'x', stage: 'Nope' },
  });
  expect(bad.isError).toBe(true);
  expect(JSON.stringify(bad.content)).toContain('In progress');
  await client2.close();
});
