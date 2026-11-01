/**
 * BACKEND ARTIFACTS, for real: a compile in the sandbox, routes found by the dry run,
 * public HTTP through the gateway, the host API, board events, and turning it off.
 * Runs when a gateway and sandboxd are up (TM_GATEWAY_URL), see gateway/.
 */
import { expect, test } from '@playwright/test';
import { call, newBoard, newPerson } from '../support/stack.js';

const GATEWAY = process.env.TM_GATEWAY_URL;

const main = (board: string) => `import { sandboxApi } from "./sandboxApi.ts";

sandboxApi.serveHttp("/hello", (req) => ({ hi: req.query.name ?? "you" }));
sandboxApi.serveHttp("/text", () => "plain");
sandboxApi.serveHttp("/d/:id", (req) => ({ status: 201, json: { id: req.params.id, body: req.json } }));
sandboxApi.serveHttp("/tickets", async () => ({ n: (await sandboxApi.tickets.list({ board: "${board}" })).length }));
sandboxApi.serveHttp("/forbidden", async () => sandboxApi.tickets.list({ board: "NOPE" }));
sandboxApi.serveHttp("/boom", () => { throw new Error("secret detail"); });
sandboxApi.serveHttp("/loop", () => { while (true) {} });
sandboxApi.onEvent("ticket.created", async (e) => {
  await sandboxApi.db.set({ path: "seen/one", value: { type: e.type } });
});
`;

test('a backend artifact, end to end', async () => {
  test.skip(!GATEWAY, 'needs a gateway');
  test.setTimeout(240_000);
  const owner = await newPerson('Backend');
  const board = await newBoard(owner);
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Has a backend' });
  await call(owner, 'artifactBoardAccessSet', { artifactId, boardId: board.id, access: 'write' });

  const opened = await call(owner, 'artifactBackendGet', { artifactId });
  expect(opened.configured).toBe(true);
  expect(opened.types).toContain('@panth977/sandbox/backend');
  expect(opened.backend).toBeNull();

  const bad = await call(owner, 'artifactBackendBuild', {
    artifactId,
    publish: true,
    files: [{ path: 'main.ts', content: 'import { sandboxApi } from "./sandboxApi.ts";\nconst n: number = sandboxApi;\n' }],
  });
  expect(bad.ok).toBe(false);
  expect(bad.diagnostics[0]).toMatchObject({ file: 'main.ts', line: 2 });
  expect(bad.buildId).toBeNull();

  const b = await call(owner, 'artifactBackendBuild', {
    artifactId,
    publish: true,
    files: [{ path: 'main.ts', content: main(board.key) }],
  });
  expect(b.diagnostics).toEqual([]);
  expect(b.ok).toBe(true);
  expect(b.routes).toContain('/d/:id');
  expect(b.events).toEqual(['ticket.created']);
  expect(b.cpuMs).toBeGreaterThan(0);

  const url = `${GATEWAY}/sandbox/${artifactId}`;
  expect(await (await fetch(`${url}/hello?name=Panth`)).json()).toEqual({ hi: 'Panth' });
  expect(await (await fetch(`${url}/text`)).text()).toBe('plain');
  const posted = await fetch(`${url}/d/42`, { method: 'POST', body: '{"a":1}' });
  expect(posted.status).toBe(201);
  expect(await posted.json()).toEqual({ id: '42', body: { a: 1 } });
  expect((await fetch(`${url}/not-a-route`)).status).toBe(404);

  await call(owner, 'ticketCreate', { boardId: board.id, title: 'One' });
  expect(await (await fetch(`${url}/tickets`)).json()).toEqual({ n: 1 });
  expect((await fetch(`${url}/forbidden`)).status).toBe(502);
  const boom = await fetch(`${url}/boom`);
  expect(boom.status).toBe(502);
  expect(await boom.text()).not.toContain('secret detail');

  // The event of that ticket reaches onEvent, and the handler writes to the artifact's db.
  await expect
    .poll(async () => (await call(owner, 'artifactDataCollections', { artifactId })).collections?.length ?? 0, { timeout: 90_000 })
    .toBeGreaterThan(0);

  // One bad loop kills that sandbox, and the next call starts a new one.
  expect((await fetch(`${url}/loop`)).status).toBe(504);
  expect(await (await fetch(`${url}/hello`)).json()).toEqual({ hi: 'you' });

  const logs = await call(owner, 'artifactBackendLogs', { artifactId });
  expect(logs.entries.some((e: { text: string }) => /cpu/.test(e.text))).toBe(true);

  const reopened = await call(owner, 'artifactBackendGet', { artifactId });
  expect(reopened.files?.[0]?.path).toBe('main.ts');
  expect(reopened.url).toBe(url);

  await call(owner, 'artifactBackendDisable', { artifactId });
  expect((await fetch(`${url}/hello`)).status).toBe(404);

  const stranger = await newPerson('Stranger');
  await expect(call(stranger, 'artifactBackendGet', { artifactId })).rejects.toThrow();
});
