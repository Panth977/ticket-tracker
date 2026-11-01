/**
 * What a backend artifact and the gateway say to each other: promise functions only.
 * HTTP and events are this project's ideas, built on them; the kit knows neither.
 */
import { api, t } from "@panth977/sandbox/server/node";

const Ticket = t.object({ key: t.string(), title: t.string(), stage: t.string(), state: t.string() });

/** What the code may call. Each is one op of backend/src/artifacts/backendHost.ts. */
export const apisSchema = {
  tickets: {
    get: api(t.object({ key: t.string() }), Ticket),
    list: api(t.object({ board: t.string(), limit: t.optional(t.integer({ min: 1, max: 200 })) }), t.array(Ticket)),
    create: api(t.object({ board: t.string(), title: t.string({ min: 1, max: 500 }), markdown: t.optional(t.string()) }), Ticket),
    comment: api(t.object({ key: t.string(), markdown: t.string({ min: 1 }) }), t.void()),
  },
  db: {
    get: api(t.object({ path: t.string() }), t.json()),
    list: api(t.object({ path: t.string(), limit: t.optional(t.integer({ min: 1, max: 500 })) }), t.json()),
    set: api(t.object({ path: t.string(), value: t.json(), merge: t.optional(t.boolean()) }), t.void()),
    delete: api(t.object({ path: t.string() }), t.void()),
  },
};

const text = t.record(t.string());

/** What sandboxApi.ts exposes. */
export const exportsSchema = {
  routes: api(t.void(), t.object({ routes: t.array(t.string()), events: t.array(t.string()) })),
  http: api(
    t.object({ route: t.string(), params: text, method: t.string(), path: t.string(), query: text, headers: text, body: t.string() }),
    t.object({ status: t.integer({ min: 100, max: 599 }), headers: text, body: t.string() }),
  ),
  event: api(t.object({ type: t.string(), board: t.string(), data: t.json() }), t.void()),
};
