/**
 * THE GATEWAY: the always-on parent of every backend artifact's sandbox. A sandbox lives
 * on its parent's connection to sandboxd, and a Firebase function cannot hold one.
 *
 *   ANY  /sandbox/{artifactId}/{**path}   public. Unknown paths stop here: routes were
 *                                         found at compile time and nothing starts.
 *   POST /internal/{compile,reload,event,logs,types}   TaskManager only (bearer secret)
 *
 * A sandbox starts on the first call that needs it and stops after sitting idle.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ARTIFACT_BACKEND_ENTRY_SOURCE,
  ARTIFACT_BACKEND_ENVIRONMENT,
  ARTIFACT_BACKEND_ROUTES_MAX,
  ARTIFACT_BACKEND_RUN_ENTRY,
  ARTIFACT_BACKEND_SANDBOX_API,
  ArtifactRouteSchema,
  matchArtifactRoute,
} from "@tm/shared/artifacts/backend";
import { type ApiDef, type CompiledCode, type Instance, type Limits, type Sandbox, type SandboxEvent, SandboxError } from "@panth977/sandbox/server/node";
import { apisSchema, exportsSchema } from "./schema.ts";

type Code = CompiledCode<typeof apisSchema, typeof exportsSchema>;
type Box = Instance<typeof exportsSchema>;

export interface Live {
  live: boolean;
  buildId?: string;
  routes?: string[];
  events?: string[];
  compiledCode?: Code;
}

/** The way back to TaskManager. */
export interface Tm {
  live(id: string): Promise<Live>;
  host(id: string, op: string, input: unknown): Promise<unknown>;
}

export interface GatewayOptions {
  sandbox: Sandbox;
  tm: Tm;
  secret: string;
  limits?: Limits;
  /** Requests per second per artifact. */
  perSecond?: number;
  liveTtlMs?: number;
  bodyBytes?: number;
}

const RUN_LIMITS: Limits = { cpus: 0.5, cpuBurst: { ms: 2000, windowMs: 10000 }, memory: 128 << 20, wallMs: 24 * 3600_000, idleMs: 600_000, callMs: 30_000 };
const DRY_LIMITS: Limits = { cpus: 1, cpuBudgetMs: 10_000, memory: 128 << 20, wallMs: 30_000 };
const LOG_LINES = 300;
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization", "content-length"]);

const refuse: ApiDef<typeof apisSchema> = (() => {
  const no = (): never => {
    throw new SandboxError("permission-denied", "Host APIs are off during the route scan: call them inside a handler");
  };
  return { tickets: { get: no, list: no, create: no, comment: no }, db: { get: no, list: no, set: no, delete: no } };
})();

function hostApi(tm: Tm, id: string): ApiDef<typeof apisSchema> {
  const call = (op: string) => (input: unknown) => tm.host(id, op, input) as Promise<never>;
  return {
    tickets: { get: call("tickets.get"), list: call("tickets.list"), create: call("tickets.create"), comment: call("tickets.comment") },
    db: { get: call("db.get"), list: call("db.list"), set: call("db.set"), delete: call("db.delete") },
  };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "cache-control": "no-store", ...headers });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), { "content-type": "application/json" });

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((ok, no) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > max) {
        no(new HttpError(413, "Body too large"));
        req.destroy();
      } else parts.push(d);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", no);
  });
}

export function createGateway(o: GatewayOptions) {
  const limits = { ...RUN_LIMITS, ...o.limits };
  const perSecond = o.perSecond ?? 60;
  const ttl = o.liveTtlMs ?? 30_000;
  const bodyBytes = o.bodyBytes ?? 1 << 20;
  const lives = new Map<string, { at: number; live: Promise<Live> }>();
  const boxes = new Map<string, Promise<Box>>();
  const logs = new Map<string, { at: number; kind: string; text: string }[]>();
  const buckets = new Map<string, { n: number; at: number }>();
  let types: string | null = null;

  const log = (id: string, kind: string, text: string) => {
    const list = logs.get(id) ?? [];
    list.push({ at: Date.now(), kind, text: text.slice(0, 2000) });
    if (list.length > LOG_LINES) list.shift();
    logs.set(id, list);
  };

  function live(id: string): Promise<Live> {
    const hit = lives.get(id);
    if (hit && Date.now() - hit.at < ttl) return hit.live;
    const p = o.tm.live(id);
    p.catch(() => lives.delete(id));
    if (lives.size > 5000) lives.clear();
    lives.set(id, { at: Date.now(), live: p });
    return p;
  }

  function box(id: string, code: Code): Promise<Box> {
    const running = boxes.get(id);
    if (running) return running;
    const started = (async () => {
      const b = o.sandbox.run({
        compiledCode: code,
        apiDef: hostApi(o.tm, id),
        limits,
        onEvent: (e: SandboxEvent) => {
          if (e.type === "log") log(id, e.stream, e.text);
          else if (e.type === "limit") log(id, "limit", `${e.limit}: ${e.used} of ${e.max}`);
          else if (e.type === "exit") log(id, "exit", e.info.reason);
        },
      });
      void b.exited.then(() => boxes.delete(id));
      await b.ready;
      return b;
    })();
    started.catch(() => boxes.delete(id));
    boxes.set(id, started);
    return started;
  }

  async function stop(id: string) {
    lives.delete(id);
    const b = boxes.get(id);
    boxes.delete(id);
    if (b) await b.then((x) => x.kill(), () => undefined);
  }

  function allowed(id: string): boolean {
    const now = Date.now();
    const b = buckets.get(id) ?? { n: perSecond, at: now };
    b.n = Math.min(perSecond, b.n + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    buckets.set(id, b);
    if (b.n < 1) return false;
    b.n--;
    return true;
  }

  async function publicCall(req: IncomingMessage, res: ServerResponse, id: string, path: string, query: URLSearchParams) {
    if (req.method === "OPTIONS") {
      return send(res, 204, "", { "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization", "access-control-max-age": "600" });
    }
    if (!ID.test(id)) return sendJson(res, 404, { error: "Not found" });
    const l = await live(id);
    const route = l.live ? l.routes?.map((r) => ({ r, params: matchArtifactRoute(r, path) })).find((x) => x.params) : undefined;
    // Stops here without running anything: this is why routes are stored at compile time.
    if (!route || !l.compiledCode) return sendJson(res, 404, { error: "Not found" });
    if (!allowed(id)) return sendJson(res, 429, { error: "Too many requests" });
    const body = await readBody(req, bodyBytes);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !HOP.has(k) && k !== "cookie") headers[k] = v;
    const b = await box(id, l.compiledCode);
    const r = await b.remote.http({ route: route.r, params: route.params!, method: req.method ?? "GET", path, query: Object.fromEntries(query), headers, body });
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v.replace(/[\r\n]/g, "");
    send(res, r.status, r.body, out);
  }

  async function compile(body: { artifactId: string; files: { path: string; content: string }[] }) {
    const none = { routes: [] as string[], events: [] as string[], cpuMs: 0 };
    const reserved = new Set(["sandboxApi.ts", ARTIFACT_BACKEND_RUN_ENTRY, "package.json"]);
    const files = [
      ...body.files.filter((f) => !reserved.has(f.path)),
      { path: "sandboxApi.ts", content: ARTIFACT_BACKEND_SANDBOX_API },
      { path: ARTIFACT_BACKEND_RUN_ENTRY, content: ARTIFACT_BACKEND_ENTRY_SOURCE },
    ];
    const environment = { ...ARTIFACT_BACKEND_ENVIRONMENT, entry: ARTIFACT_BACKEND_RUN_ENTRY };
    const r = await o.sandbox.compile({ environment, files, apisSchema, exportsSchema });
    if (!r.ok) return { ok: false, diagnostics: r.diagnostics, ...none, cpuMs: r.usage.cpuMs };
    // The dry run: start it once, with host APIs off, and ask what it serves.
    const stderr: string[] = [];
    const scan = o.sandbox.run({
      compiledCode: r.compiledCode,
      apiDef: refuse,
      limits: DRY_LIMITS,
      onEvent: (e: SandboxEvent) => {
        if (e.type === "log") stderr.push(e.text);
      },
    });
    let found: { routes: string[]; events: string[] };
    try {
      await scan.ready;
      found = await scan.remote.routes(undefined);
    } catch (e) {
      const text = stderr.join("").trim().slice(-2000) || String((e as Error).message);
      await scan.kill().catch(() => undefined);
      return { ok: false, diagnostics: [{ message: `Could not start: ${text}`, severity: "error", source: "build" }], ...none, cpuMs: r.usage.cpuMs };
    }
    await scan.kill();
    const bad = found.routes.filter((x) => !ArtifactRouteSchema.safeParse(x).success);
    if (bad.length || found.routes.length > ARTIFACT_BACKEND_ROUTES_MAX) {
      const message = bad.length ? `Bad route: ${bad[0]}` : `Over ${ARTIFACT_BACKEND_ROUTES_MAX} routes`;
      return { ok: false, diagnostics: [{ message, severity: "error", source: "schema" }], ...none, cpuMs: r.usage.cpuMs };
    }
    return { ok: true, diagnostics: r.diagnostics, routes: found.routes, events: found.events, cpuMs: r.usage.cpuMs, compiledCode: r.compiledCode };
  }

  async function internal(op: string, raw: unknown): Promise<unknown> {
    const body = raw as { artifactId: string; event: string; boardId: string; data?: unknown; files: { path: string; content: string }[] };
    switch (op) {
      case "compile":
        return compile(body);
      case "reload":
        await stop(body.artifactId);
        return { ok: true };
      case "event": {
        const l = await live(body.artifactId);
        if (!l.live || !l.compiledCode) return { ok: true, skipped: true };
        const b = await box(body.artifactId, l.compiledCode);
        await b.remote.event({ type: body.event, board: body.boardId, data: body.data ?? null });
        return { ok: true };
      }
      case "logs":
        return { entries: logs.get(body.artifactId) ?? [], running: boxes.has(body.artifactId) };
      case "types":
        if (!types) {
          const f = await o.sandbox.typings({ environment: ARTIFACT_BACKEND_ENVIRONMENT, apisSchema, exportsSchema });
          types = f[0]?.content as string;
        }
        return { types };
    }
    throw new HttpError(404, "No such op");
  }

  const digest = (s: string) => createHash("sha256").update(s).digest();
  const authed = (h: string | undefined) => !!h && timingSafeEqual(digest(h), digest(`Bearer ${o.secret}`));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://gateway");
    try {
      const pub = /^\/sandbox\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (pub) return await publicCall(req, res, pub[1]!, pub[2] ?? "/", url.searchParams);
      const inn = /^\/internal\/([a-z]+)$/.exec(url.pathname);
      if (inn && req.method === "POST") {
        if (!authed(req.headers.authorization)) return sendJson(res, 401, { error: "Unauthorized" });
        const body = JSON.parse((await readBody(req, 16 << 20)) || "{}");
        return sendJson(res, 200, await internal(inn[1]!, body));
      }
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, running: boxes.size });
      return sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      const code = (e as SandboxError)?.code;
      if (code === "deadline" || code === "exited") return sendJson(res, 504, { error: "The backend did not answer" });
      // Never echo what a sandbox threw at a stranger: it lands in the logs instead.
      const id = /^\/sandbox\/([^/]+)/.exec(url.pathname)?.[1];
      if (id) log(id, "error", String((e as Error)?.message ?? e));
      console.error(url.pathname, e);
      return sendJson(res, 502, { error: "The backend failed" });
    }
  }

  return { handle, stop, running: () => boxes.size };
}
