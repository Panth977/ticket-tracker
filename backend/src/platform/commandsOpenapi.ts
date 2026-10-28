/**
 * OpenAPI 3.1 for the app's command API (POST /api/{command}), GENERATED FROM THE COMMAND
 * REGISTRY — the same zod schemas the door parses requests with and the handlers answer in.
 * Served at GET /api/openapi.json (public, like /v1/openapi.json); the IceBase console shows it.
 */
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { COMMANDS } from '@tm/shared';
import type { z } from 'zod';

type Json = Record<string, unknown>;
const schema = (s: z.ZodTypeAny): Json => {
  const out = toJsonSchemaCompat(s as never, { target: 'draft-2020-12' }) as Json;
  delete out.$schema;
  return out;
};

let cached: Json | null = null;
export function commandsOpenApi(): Json {
  if (cached) return cached;
  const paths: Record<string, Json> = {};
  for (const spec of Object.values(COMMANDS) as { name: string; req: z.ZodTypeAny; res: z.ZodTypeAny; permission: string; errors: readonly string[]; scopes?: readonly string[]; source: string }[]) {
    paths[`/api/${spec.name}`] = {
      post: {
        operationId: spec.name,
        summary: spec.permission,
        tags: [spec.source],
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
