/**
 * BACKEND ARTIFACTS. An artifact may have a backend: code that runs in a sandbox on the
 * worker machine, answers public HTTP at {gateway}/sandbox/{artifactId}/{**path} and reacts
 * to board events. It works in the browser's Backend tab, as `main.ts` next to
 * `sandboxApi.ts`.
 *
 *   artifacts/{id}.backend                        ArtifactBackendSchema: what is live
 *   Storage artifacts/{id}/backend/{buildId}.json source files + compiledCode
 *
 * The gateway (package gateway/) owns the sandboxes. Routes and events are found once,
 * by a dry run at compile time, and stored here, so an unknown path is refused without
 * starting anything. The kit knows nothing about HTTP: serveHttp is this file's work, on
 * top of a plain exported function.
 */
import { z } from 'zod';
import { MillisSchema } from '../types/index.js';

export const ARTIFACT_BACKEND_ENTRY = 'main.ts';
/** What the worker runs for now. Others follow. */
export const ARTIFACT_BACKEND_ENVIRONMENT = { runtime: 'node', version: '22' } as const;
export const ARTIFACT_BACKEND_MAX_FILES = 200;
export const ARTIFACT_BACKEND_MAX_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_BACKEND_ROUTES_MAX = 200;
export const ARTIFACT_BACKEND_EVENTS_MAX = 50;

/** A route: '/hello', '/devices/:id'. */
export const ArtifactRouteSchema = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~:/-]*$/, 'A route starts with / and holds URL characters');

export const ArtifactBackendSchema = z.object({
  buildId: z.string().min(1).max(64),
  routes: z.array(ArtifactRouteSchema).max(ARTIFACT_BACKEND_ROUTES_MAX),
  events: z.array(z.string().max(80)).max(ARTIFACT_BACKEND_EVENTS_MAX),
  publishedAt: MillisSchema,
});
export type ArtifactBackend = z.infer<typeof ArtifactBackendSchema>;

export const ArtifactBackendDiagnosticSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
  source: z.string(),
});
export type ArtifactBackendDiagnostic = z.infer<typeof ArtifactBackendDiagnosticSchema>;

export const ArtifactBackendFileSchema = z.object({
  path: z.string().min(1).max(256),
  content: z.string().max(ARTIFACT_BACKEND_MAX_BYTES),
});
export type ArtifactBackendFile = z.infer<typeof ArtifactBackendFileSchema>;

export const ArtifactBackendLogSchema = z.object({
  at: z.number(),
  kind: z.string(),
  text: z.string(),
});
export type ArtifactBackendLog = z.infer<typeof ArtifactBackendLogSchema>;

/** Does a stored route match a request path? `:name` is one segment. */
export function matchArtifactRoute(
  route: string,
  path: string,
): Record<string, string> | null {
  const a = route.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg.startsWith(':') && b[i]) params[seg.slice(1)] = decodeURIComponent(b[i]!);
    else if (seg !== b[i]) return null;
  }
  return params;
}

/** The first code a new backend opens with. */
export const ARTIFACT_BACKEND_STARTER = `import { sandboxApi } from "./sandboxApi.ts";

// Anyone can call this: GET {your backend URL}/hello
sandboxApi.serveHttp("/hello", (req) => {
  return { message: "Hi!", from: req.query.name ?? "nobody" };
});

// Runs on events of the boards this artifact is granted.
sandboxApi.onEvent("ticket.created", async (e) => {
  console.log("new ticket", e.data);
});
`;

/**
 * The file beside main.ts. The build always replaces it with this text, so what is
 * in the editor is what runs: promise functions and nothing else underneath.
 */
export const ARTIFACT_BACKEND_SANDBOX_API = `// Provided by TaskManager. A build always restores this file.
import { expose, host } from "@panth977/sandbox/backend";

export interface HttpRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Raw body text. */
  body: string;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
}
export type HttpResult = string | object | { status?: number; headers?: Record<string, string>; body?: string; json?: unknown };
export interface BoardEvent {
  type: string;
  board: string;
  data: unknown;
}

const routes = new Map<string, (req: HttpRequest) => HttpResult | Promise<HttpResult>>();
const events = new Map<string, (e: BoardEvent) => void | Promise<void>>();

export const sandboxApi = {
  /** Serve a path. Call it at the top level of a file: routes are read once, at build. */
  serveHttp(path: string, handler: (req: HttpRequest) => HttpResult | Promise<HttpResult>): void {
    routes.set(path, handler);
  },
  /** React to a board event. Call it at the top level too. */
  onEvent(type: string, handler: (e: BoardEvent) => void | Promise<void>): void {
    events.set(type, handler);
  },
  /** Tickets of the boards granted to this artifact. */
  tickets: host.tickets,
  /** This artifact's own database. */
  db: host.db,
};

function reply(r: HttpResult) {
  if (typeof r === "string") return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: r };
  const o = r as { status?: number; headers?: Record<string, string>; body?: string; json?: unknown };
  if (o.status !== undefined || o.body !== undefined || o.json !== undefined || o.headers !== undefined) {
    const isJson = o.json !== undefined;
    return {
      status: o.status ?? 200,
      headers: { ...(isJson ? { "content-type": "application/json" } : {}), ...o.headers },
      body: isJson ? JSON.stringify(o.json) : o.body ?? "",
    };
  }
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(r) };
}

/** Called by the build's entry, after your files have run. */
export function start(): void {
  expose({
    routes: () => ({ routes: [...routes.keys()], events: [...events.keys()] }),
    http: async ({ route, params, method, path, query, headers, body }) => {
      const handler = routes.get(route);
      if (!handler) return { status: 404, headers: {}, body: "" };
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      return reply(await handler({ method, path, params, query, headers, body, json }));
    },
    event: async (e) => {
      await events.get(e.type)?.(e);
    },
  });
}
`;

/** The build's real entry: your code first, so its serveHttp calls are all in. */
export const ARTIFACT_BACKEND_ENTRY_SOURCE = `import { start } from "./sandboxApi.ts";
await import("./main.ts");
start();
`;
export const ARTIFACT_BACKEND_RUN_ENTRY = 'sandbox-entry.ts';
