/**
 * OpenAPI 3.1 for the app's command API (POST /api/{command}), GENERATED FROM THE COMMAND
 * REGISTRY — the same zod schemas the door parses requests with and the handlers answer in.
 * Served at GET /api/openapi.json (public, like /v1/openapi.json); the IceBase console shows it.
 */
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { COMMANDS } from '@tm/shared';
import type { z } from 'zod';

type Json = Record<string, unknown>;
/**
 * The converter writes repeated sub-schemas as refs relative to the schema's own root
 * ('#/properties/a/…'), which mean something else once the schema sits inside an OpenAPI
 * document: they are inlined here (a ref inside its own target is left as an open object).
 */
export function inline(root: Json): Json {
  const at = (ref: string): unknown => ref.slice(2).split('/').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Json)[decodeURIComponent(k.replace(/~1/g, '/').replace(/~0/g, '~'))] : undefined), root);
  const walk = (n: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(n)) return n.map((x) => walk(x, seen));
    if (!n || typeof n !== 'object') return n;
    const o = n as Json;
    if (typeof o.$ref === 'string' && o.$ref.startsWith('#/')) {
      if (seen.has(o.$ref)) return { type: 'object' };
      return walk(at(o.$ref) ?? { type: 'object' }, new Set([...seen, o.$ref]));
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, seen)]));
  };
  return walk(root, new Set()) as Json;
}
const schema = (s: z.ZodTypeAny): Json => {
  const out = toJsonSchemaCompat(s as never, { target: 'draft-2020-12' }) as Json;
  delete out.$schema;
  return inline(out);
};

/** The area a command belongs to, for grouping: its name's first word (boardCreate → board). */
const area = (name: string) => /^[a-z]+/.exec(name)?.[0] ?? 'other';

let cached: Json | null = null;
export function commandsOpenApi(): Json {
  if (cached) return cached;
  const paths: Record<string, Json> = {};
  for (const spec of Object.values(COMMANDS) as { name: string; req: z.ZodTypeAny; res: z.ZodTypeAny; permission: string; errors: readonly string[]; scopes?: readonly string[]; source: string }[]) {
    paths[`/api/${spec.name}`] = {
      post: {
        operationId: spec.name,
        summary: spec.name,
        description: `**Who may call it:** ${spec.permission}${spec.errors.length ? `\n\n**Errors:** ${spec.errors.map((e) => `\`${e}\``).join(', ')}` : ''}${spec.scopes?.length ? `\n\n**Token scopes (any one):** ${spec.scopes.map((x) => `\`${x}\``).join(', ')}` : ''}`,
        tags: [area(spec.name)],
        'x-scopes': spec.scopes ?? [],
        'x-errors': spec.errors,
        security: [{ firebaseIdToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: schema(spec.req) } } },
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: schema(spec.res) } } },
          default: { description: 'problem+json', content: { 'application/problem+json': { schema: { type: 'object' } } } },
        },
      },
    };
  }
  return (cached = {
    openapi: '3.1.0',
    info: { title: 'TaskManager commands', version: '1', description: 'The app API: POST /api/{command} with a Firebase ID token; the body is the command request, the answer its response.' },
    components: { securitySchemes: { firebaseIdToken: { type: 'http', scheme: 'bearer', description: 'A Firebase ID token of a signed-in user' } } },
    paths,
  });
}
