/** Phase-2 API helpers that need no emulator: scope gates, upload decoding, the OpenAPI document. */
import { describe, expect, it } from 'vitest';
import { REST_ROUTES, restPatchScopes, type Scope } from '@tm/shared';
import { requireScope, requireScopes } from '../../src/platform/auth.js';
import { openApiDocument } from '../../src/platform/openapi.js';
import { uploadBytes } from '../../src/platform/uploads.js';
import type { ServerCtx } from '../../src/runtime/context.js';

const ctx = (scopes?: Scope[]) =>
  ({ actor: 'u1', via: 'api', now: 0, ...(scopes ? { scopes } : {}) }) as unknown as ServerCtx;

describe('scope gates', () => {
  it('any-of for a route; full sessions pass; [] means any credential', () => {
    expect(() =>
      requireScope(ctx(['tickets:read']), ['tickets:read', 'tickets:create']),
    ).not.toThrow();
    expect(() => requireScope(ctx(['comments:read']), ['tickets:read'])).toThrow(/tickets:read/);
    expect(() => requireScope(ctx(), ['webhooks:manage'])).not.toThrow();
    expect(() => requireScope(ctx(['events:read']), [])).not.toThrow();
  });

  it('a PATCH needs every scope its fields touch', () => {
    const c = ctx(['tickets:update']);
    expect(() => requireScopes(c, restPatchScopes({ title: 'x', fields: {} }))).not.toThrow();
    expect(() => requireScopes(c, restPatchScopes({ title: 'x', stage: 'Done' }))).toThrow(
      /tickets:move/,
    );
    expect(() => requireScopes(c, restPatchScopes({ assignees: ['me'] }))).toThrow(
      /tickets:assign/,
    );
  });
});

describe('uploadBytes', () => {
  it('text is UTF-8; base64 and base64url decode; garbage is refused', () => {
    expect(new TextDecoder().decode(uploadBytes({ text: '# Plan ✓' }))).toBe('# Plan ✓');
    expect(
      new TextDecoder().decode(
        uploadBytes({ content_base64: Buffer.from('<h1>hi</h1>').toString('base64') }),
      ),
    ).toBe('<h1>hi</h1>');
    expect([
      ...uploadBytes({ content_base64: Buffer.from([251, 255]).toString('base64url') }),
    ]).toEqual([251, 255]);
    expect(() => uploadBytes({ content_base64: 'not base64!' })).toThrow();
  });
});

describe('openapi.json', () => {
  const fakeCtx = {
    req: { url: 'https://api.example/v1/openapi.json', header: () => undefined },
  } as never;
  it('documents every REST_ROUTES route with its scopes, multipart uploads and the SSE stream', () => {
    const doc = openApiDocument(fakeCtx) as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          {
            description?: string;
            requestBody?: { content: Record<string, unknown> };
            responses: Record<string, { content?: Record<string, unknown> }>;
          }
        >
      >;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    for (const r of REST_ROUTES)
      expect(doc.paths[r.path]?.[r.method.toLowerCase()], `${r.method} ${r.path}`).toBeTruthy();
    expect(doc.paths['/v1/tickets/{KEY}']!.patch!.description).toContain('tickets:move');
    expect(Object.keys(doc.paths['/v1/tickets/{KEY}/files']!.post!.requestBody!.content)).toEqual([
      'application/json',
      'multipart/form-data',
    ]);
    expect(Object.keys(doc.paths['/v1/events/stream']!.get!.responses['200']!.content!)).toEqual([
      'text/event-stream',
    ]);
    for (const name of [
      'Me',
      'TicketDetail',
      'PostMessage',
      'Uploaded',
      'FileWithContent',
      'EventList',
      'Ack',
    ])
      expect(doc.components.schemas[name], name).toBeTruthy();
  });
});
