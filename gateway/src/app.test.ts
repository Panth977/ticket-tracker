import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { createGateway, type Live, type Tm } from "./app.ts";

const live: Live = { live: true, buildId: "b1", routes: ["/hello", "/d/:id"], events: [], compiledCode: { format: 1 } as never };
let tmLive = 0;
let runs = 0;
let lastHttp: { params: Record<string, string>; query: Record<string, string>; headers: Record<string, string> };
let throwFrom: Error | null = null;
const fakeBox = () => {
  runs++;
  let done!: (i: unknown) => void;
  const exited = new Promise((r) => (done = r));
  return {
    ready: Promise.resolve(),
    exited,
    kill: async () => done({ reason: "killed" }),
    remote: {
      http: async (req: typeof lastHttp) => {
        lastHttp = req;
        if (throwFrom) throw throwFrom;
        return { status: 200, headers: { "x-a": "1\r\nevil: 1", connection: "close" }, body: "hi" };
      },
      event: async () => undefined,
      routes: async () => ({ routes: ["/hello"], events: ["ticket.created"] }),
    },
  };
};
const sandbox = {
  run: fakeBox,
  compile: async () => ({ ok: true, compiledCode: { format: 1 }, diagnostics: [], usage: { cpuMs: 5 } }),
  typings: async () => [{ path: "sandbox.d.ts", content: "types" }],
} as never;
const tm: Tm = {
  live: async (id) => (tmLive++, id === "unknown1" ? { live: false } : live),
  host: async () => null,
};
const gateway = createGateway({ sandbox, tm, secret: "s3cret", perSecond: 5 });
const server = http.createServer((q, s) => void gateway.handle(q, s)).listen(0);
const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

test("unknown path: 404, nothing starts", async () => {
  const r = await fetch(`${base()}/sandbox/artifact1/nope`);
  assert.equal(r.status, 404);
  assert.equal(runs, 0);
});

test("artifact with no backend: 404, asked once then cached", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base()}/sandbox/unknown1/hello`)).status, 404);
  assert.equal(tmLive, 2); // artifact1 + unknown1
});

test("known route starts one sandbox, passes params, cleans headers", async () => {
  const [a, b] = await Promise.all([fetch(`${base()}/sandbox/artifact1/d/42?x=1`), fetch(`${base()}/sandbox/artifact1/hello`)]);
  assert.equal(a.status, 200);
  assert.equal(await b.text(), "hi");
  assert.equal(runs, 1);
  const c = await fetch(`${base()}/sandbox/artifact1/d/42?x=1`, { headers: { cookie: "session=1" } });
  assert.equal(lastHttp.params.id, "42");
  assert.equal(lastHttp.query.x, "1");
  assert.equal(lastHttp.headers.cookie, undefined);
  assert.equal(c.headers.get("x-a"), "1evil: 1");
});

test("a sandbox error stays private", async () => {
  await new Promise((r) => setTimeout(r, 1100));
  throwFrom = new Error("db password is hunter2");
  const r = await fetch(`${base()}/sandbox/artifact1/hello`);
  throwFrom = null;
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("hunter2"));
});

test("rate limit per artifact", async () => {
  const all = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base()}/sandbox/artifact1/hello`)));
  assert.ok(all.some((r) => r.status === 429));
});

test("body cap", async () => {
  await new Promise((r) => setTimeout(r, 1100));
  const r = await fetch(`${base()}/sandbox/artifact1/hello`, { method: "POST", body: "x".repeat(2 << 20) }).catch(() => null);
  assert.ok(r === null || r.status === 413);
});

test("internal needs the secret", async () => {
  const no = await fetch(`${base()}/internal/compile`, { method: "POST", body: "{}" });
  assert.equal(no.status, 401);
  const bad = await fetch(`${base()}/internal/compile`, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } });
  assert.equal(bad.status, 401);
});

test("compile finds routes by dry run", async () => {
  const r = await fetch(`${base()}/internal/compile`, {
    method: "POST",
    headers: { authorization: "Bearer s3cret" },
    body: JSON.stringify({ artifactId: "artifact1", files: [{ path: "main.ts", content: "" }] }),
  });
  const v = (await r.json()) as { routes: string[]; events: string[] };
  assert.deepEqual(v.routes, ["/hello"]);
  assert.deepEqual(v.events, ["ticket.created"]);
});

test("reload stops the sandbox and rereads what is live", async () => {
  await fetch(`${base()}/internal/reload`, { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ artifactId: "artifact1" }) });
  assert.equal(gateway.running(), 0);
});
