/** §AA3 / §AA4 (docs/plan/agents.html): an agent's { build, data } on an artifact, and the data API's JSON. */
import { describe, expect, it } from 'vitest';
import { fixtures } from '../schema/fixtures.js';
import { MCP_TOOLS, McpToolSchemas, mcpToolAllowed } from '../api/mcp.js';
import { PublicArtifactMemberSchema, PublicArtifactSchema } from '../api/public.js';
import { REST_ROUTES, RestArtifactAccessBodySchema } from '../api/rest.js';
import { AGENT_TOKEN_SCOPES } from '../types/index.js';
import {
  ARTIFACT_DATA_BATCH_MAX,
  ArtifactDataBatchSchema,
  ArtifactDataQuerySchema,
  ArtifactValueError,
  dateEscape,
  decodeJsonDocument,
  decodeJsonValue,
  encodeJsonValue,
  escapeKeyOf,
  formatWhereParam,
  isDateEscape,
  isServerTimeEscape,
  parseOrderByParam,
  parseWhereParam,
  SERVER_TIME_JSON,
} from './data.js';
import {
  agentAccessIsNone,
  agentAccessOf,
  ARTIFACT_AGENT_FULL,
  ARTIFACT_AGENT_NONE,
  artifactAgentCan,
  ArtifactAgentAccessSchema,
  ArtifactSchema,
  canBuild,
  canOpenArtifact,
  canReadData,
  canWriteData,
} from './schema.js';

describe('§AA3 an agent on an artifact: build and data, separately', () => {
  it("agentAccessOf normalises both stored forms; 'editor' is { build: true, data: 'write' }", () => {
    expect(agentAccessOf('editor')).toEqual({ build: true, data: 'write' });
    expect(agentAccessOf({ build: true, data: 'none' })).toEqual({ build: true, data: 'none' });
    expect(agentAccessOf({ build: false, data: 'read' })).toEqual({ build: false, data: 'read' });
    // never more than the document says: absent, null and junk are "not on it"
    for (const junk of [
      undefined,
      null,
      'viewer',
      'owner',
      7,
      true,
      [],
      {},
      { build: 'yes', data: 'all' },
    ])
      expect(agentAccessOf(junk)).toEqual(ARTIFACT_AGENT_NONE);
    // a fresh object every time: the constants cannot be mutated through it
    const a = agentAccessOf('editor');
    a.build = false;
    expect(ARTIFACT_AGENT_FULL).toEqual({ build: true, data: 'write' });
    expect(agentAccessOf('editor').build).toBe(true);
  });
  it('the predicates', () => {
    const build = { build: true, data: 'none' };
    const read = { build: false, data: 'read' };
    const write = { build: false, data: 'write' };
    expect([canBuild(build), canReadData(build), canWriteData(build)]).toEqual([
      true,
      false,
      false,
    ]);
    expect([canBuild(read), canReadData(read), canWriteData(read)]).toEqual([false, true, false]);
    expect([canBuild(write), canReadData(write), canWriteData(write)]).toEqual([false, true, true]);
    expect([canBuild('editor'), canReadData('editor'), canWriteData('editor')]).toEqual([
      true,
      true,
      true,
    ]);
    // any one permission lets it open (list, read the description); none does not
    for (const v of [build, read, write, 'editor']) expect(canOpenArtifact(v)).toBe(true);
    for (const v of [undefined, ARTIFACT_AGENT_NONE]) {
      expect(canOpenArtifact(v)).toBe(false);
      expect(canBuild(v) || canReadData(v) || canWriteData(v)).toBe(false);
    }
    expect(agentAccessIsNone(ARTIFACT_AGENT_NONE)).toBe(true);
    expect(agentAccessIsNone({ build: false, data: 'read' })).toBe(false);
    // an agent never owns, shares, renames or deletes — whatever it holds
    expect(artifactAgentCan.manage('editor')).toBe(false);
    expect(artifactAgentCan.manage({ build: true, data: 'write' })).toBe(false);
  });
  it("the stored map takes the object OR the legacy literal 'editor', and nothing else", () => {
    const a = fixtures.artifacts;
    const AG = 'ag_Bu1lder000000001';
    expect(ArtifactSchema.safeParse({ ...a, agents: { [AG]: 'editor' } }).success).toBe(true);
    expect(
      ArtifactSchema.safeParse({ ...a, agents: { [AG]: { build: true, data: 'read' } } }).success,
    ).toBe(true);
    expect(ArtifactSchema.safeParse({ ...a, agents: { [AG]: 'viewer' } }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...a, agents: { [AG]: { build: true } } }).success).toBe(
      false,
    );
    expect(
      ArtifactAgentAccessSchema.safeParse({ build: true, data: 'write', extra: 1 }).success,
    ).toBe(false);
  });
  it('REST + public shapes: agent_access beside agent, and on members / the caller', () => {
    const AG = 'ag_Bu1lder000000001';
    const b = RestArtifactAccessBodySchema;
    expect(b.safeParse({ agent: AG, agent_access: { build: true, data: 'none' } }).success).toBe(
      true,
    );
    expect(b.safeParse({ agent: AG, role: 'editor' }).success).toBe(true);
    expect(b.safeParse({ agent: AG, role: null }).success).toBe(true);
    expect(b.safeParse({ agent: AG }).success).toBe(false);
    expect(b.safeParse({ email: 'x@example.com', role: 'viewer' }).success).toBe(true);
    expect(b.safeParse({ email: 'x@example.com' }).success).toBe(false);
    expect(
      b.safeParse({
        email: 'x@example.com',
        role: 'viewer',
        agent_access: { build: true, data: 'none' },
      }).success,
    ).toBe(false);
    const member = { id: AG, kind: 'agent', name: 'Builder', email: '', role: 'editor' };
    expect(PublicArtifactMemberSchema.safeParse(member).success).toBe(true);
    expect(
      PublicArtifactMemberSchema.parse({ ...member, agent_access: { build: false, data: 'read' } })
        .agent_access,
    ).toEqual({ build: false, data: 'read' });
    expect(PublicArtifactSchema.shape.agent_access.isOptional()).toBe(true);
  });
});

describe('§AA4 values are JSON with two escapes', () => {
  const dec = { date: (at: Date) => ({ TS: at.getTime() }), serverTime: () => 'SERVER' };
  const enc = {
    asDate: (v: unknown) =>
      v && typeof v === 'object' && 'TS' in v ? new Date((v as { TS: number }).TS) : null,
  };

  it('$date is a timestamp BOTH ways; nested maps and arrays are walked', () => {
    const iso = '2026-09-30T05:30:00.000Z';
    const stored = decodeJsonDocument(
      {
        at: { $date: iso },
        n: 1,
        s: 'x',
        ok: true,
        nil: null,
        nest: { when: { $date: iso }, list: [{ $date: iso }, { deep: { $date: iso } }] },
      },
      dec,
    );
    const ts = { TS: Date.parse(iso) };
    expect(stored).toEqual({
      at: ts,
      n: 1,
      s: 'x',
      ok: true,
      nil: null,
      nest: { when: ts, list: [ts, { deep: ts }] },
    });
    expect(encodeJsonValue(stored, enc)).toEqual({
      at: { $date: iso },
      n: 1,
      s: 'x',
      ok: true,
      nil: null,
      nest: { when: { $date: iso }, list: [{ $date: iso }, { deep: { $date: iso } }] },
    });
    // a Date (what a test double or RTDB never has, but the encoder tolerates) is a $date too
    expect(encodeJsonValue({ d: new Date(iso) }, { asDate: () => null })).toEqual({
      d: { $date: iso },
    });
    expect(dateEscape(Date.parse(iso))).toEqual({ $date: iso });
    expect(isDateEscape({ $date: iso })).toBe(true);
    expect(isDateEscape({ $date: iso, more: 1 })).toBe(false);
  });
  it('$serverTime in a write is the server clock — never inside an array', () => {
    expect(
      decodeJsonDocument({ updatedAt: { $serverTime: true }, a: { b: SERVER_TIME_JSON } }, dec),
    ).toEqual({
      updatedAt: 'SERVER',
      a: { b: 'SERVER' },
    });
    expect(isServerTimeEscape(SERVER_TIME_JSON)).toBe(true);
    expect(() => decodeJsonDocument({ list: [{ $serverTime: true }] }, dec)).toThrow(
      /list\[0\].*inside an array/,
    );
    expect(() => decodeJsonDocument({ list: [{ at: { $serverTime: true } }] }, dec)).toThrow(
      ArtifactValueError,
    );
    expect(() => decodeJsonDocument({ at: { $serverTime: false } }, dec)).toThrow(/\$serverTime/);
  });
  it('every other $-prefixed single-key object is refused; several keys may use $ freely', () => {
    expect(() => decodeJsonDocument({ a: { $inc: 1 } }, dec)).toThrow(
      /a: "\$inc" is not a known escape/,
    );
    expect(() => decodeJsonDocument({ a: { b: [{ $delete: true }] } }, dec)).toThrow(/a\.b\[0\]/);
    expect(() => decodeJsonDocument({ at: { $date: 'yesterday' } }, dec)).toThrow(
      /at: "\$date" takes an ISO/,
    );
    expect(() => decodeJsonDocument({ at: { $date: 5 } }, dec)).toThrow(ArtifactValueError);
    expect(decodeJsonDocument({ price: { $usd: 5, $eur: 4 } }, dec)).toEqual({
      price: { $usd: 5, $eur: 4 },
    });
    expect(escapeKeyOf({ $date: 'x' })).toBe('$date');
    expect(escapeKeyOf({ date: 'x' })).toBeNull();
    expect(escapeKeyOf([{ $date: 'x' }])).toBeNull();
  });
  it('a document is an object; values are JSON', () => {
    for (const bad of [null, 5, 'x', [], [{}]])
      expect(() => decodeJsonDocument(bad, dec)).toThrow(/JSON object/);
    expect(() => decodeJsonValue({ n: Number.NaN }, dec)).toThrow(/n: not a finite number/);
    expect(() => decodeJsonValue({ d: new Date() }, dec)).toThrow(/d: not a JSON value/);
    expect(decodeJsonValue([1, 'a', null], dec)).toEqual([1, 'a', null]);
  });
  it('?where=field,op,value and ?order_by=', () => {
    expect(parseWhereParam('status,==,open')).toEqual(['status', '==', 'open']);
    expect(parseWhereParam('n,>,5')).toEqual(['n', '>', 5]);
    expect(parseWhereParam('done,==,true')).toEqual(['done', '==', true]);
    expect(parseWhereParam('tags,array-contains-any,["a","b"]')).toEqual([
      'tags',
      'array-contains-any',
      ['a', 'b'],
    ]);
    expect(parseWhereParam('title,==,a, b, c')).toEqual(['title', '==', 'a, b, c']);
    expect(parseWhereParam('at,>=,{"$date":"2026-01-01T00:00:00Z"}')).toEqual([
      'at',
      '>=',
      { $date: '2026-01-01T00:00:00Z' },
    ]);
    expect(parseWhereParam('n,~,5')).toBeNull();
    expect(parseWhereParam('n,==')).toBeNull();
    expect(parseWhereParam(',==,5')).toBeNull();
    expect(parseWhereParam(formatWhereParam(['n', 'in', [1, 2]]))).toEqual(['n', 'in', [1, 2]]);
    expect(parseWhereParam(formatWhereParam(['s', '==', '5']))).toEqual(['s', '==', '5']);
    expect(parseOrderByParam('score')).toEqual(['score', 'asc']);
    expect(parseOrderByParam('score,desc')).toEqual(['score', 'desc']);
    expect(parseOrderByParam('score,up')).toBeNull();
    expect(parseOrderByParam('')).toBeNull();
  });
  it('list defaults to 100, at most 500; a batch is 1–400 writes', () => {
    expect(ArtifactDataQuerySchema.parse({}).limit).toBe(100);
    expect(ArtifactDataQuerySchema.safeParse({ limit: 500 }).success).toBe(true);
    expect(ArtifactDataQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    const w = { op: 'set', path: 'a/b', data: { n: 1 } };
    expect(
      ArtifactDataBatchSchema.safeParse({
        writes: [w, { op: 'update', path: 'a/b', data: {} }, { op: 'delete', path: 'a/b' }],
      }).success,
    ).toBe(true);
    expect(ArtifactDataBatchSchema.safeParse({ writes: [] }).success).toBe(false);
    expect(
      ArtifactDataBatchSchema.safeParse({ writes: Array(ARTIFACT_DATA_BATCH_MAX).fill(w) }).success,
    ).toBe(true);
    expect(
      ArtifactDataBatchSchema.safeParse({ writes: Array(ARTIFACT_DATA_BATCH_MAX + 1).fill(w) })
        .success,
    ).toBe(false);
    expect(
      ArtifactDataBatchSchema.safeParse({ writes: [{ op: 'delete', path: 'a/b', data: {} }] })
        .success,
    ).toBe(false);
    expect(
      ArtifactDataBatchSchema.safeParse({ writes: [{ op: 'upsert', path: 'a/b', data: {} }] })
        .success,
    ).toBe(false);
  });
});

describe('§AA4 the routes and tools are registered', () => {
  it('REST: firestore, batch, rtdb and files routes with artifact scopes', () => {
    const data = REST_ROUTES.filter((r) => r.path.startsWith('/v1/artifacts/{id}/data/'));
    expect(
      data.map((r) => `${r.method} ${r.path.slice('/v1/artifacts/{id}/data/'.length)}`).sort(),
    ).toEqual(
      [
        'DELETE files/{path}',
        'DELETE firestore/{path}',
        'DELETE rtdb/{path}',
        'GET files',
        'GET files/{path}',
        'GET firestore/{path}',
        'GET rtdb/{path}',
        'PATCH firestore/{path}',
        'PATCH rtdb/{path}',
        'POST batch',
        'POST firestore/{path}',
        'POST rtdb/{path}',
        'PUT files/{path}',
        'PUT firestore/{path}',
        'PUT rtdb/{path}',
      ].sort(),
    );
    for (const r of data)
      expect([...r.scopes]).toEqual(
        r.method === 'GET' ? ['artifacts:read', 'artifacts:write'] : ['artifacts:write'],
      );
  });
  it('MCP: artifact_data_get / list / set / batch; an agent token sees all four', () => {
    const names = [
      'artifact_data_get',
      'artifact_data_list',
      'artifact_data_set',
      'artifact_data_batch',
    ] as const;
    for (const n of names) {
      expect(MCP_TOOLS[n]).toBeDefined();
      expect(mcpToolAllowed(n, AGENT_TOKEN_SCOPES)).toBe(true);
      expect(mcpToolAllowed(n, ['tickets:read'])).toBe(false);
    }
    expect(mcpToolAllowed('artifact_data_get', ['artifacts:read'])).toBe(true);
    expect(mcpToolAllowed('artifact_data_set', ['artifacts:read'])).toBe(false);
    expect(MCP_TOOLS.artifact_data_get.readOnly && MCP_TOOLS.artifact_data_list.readOnly).toBe(
      true,
    );
    expect(
      McpToolSchemas.artifact_data_list.safeParse({
        id: 'artifact_1',
        path: 'scores',
        where: [['n', '>', 1]],
        order_by: 'n,desc',
        limit: 10,
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.artifact_data_list.safeParse({
        id: 'artifact_1',
        path: 'scores',
        where: [['n', '~', 1]],
      }).success,
    ).toBe(false);
    expect(
      McpToolSchemas.artifact_data_set.safeParse({
        id: 'artifact_1',
        path: 'scores/a',
        data: { n: 1 },
        merge: true,
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.artifact_data_batch.safeParse({
        id: 'artifact_1',
        writes: [{ op: 'delete', path: 'scores/a' }],
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.artifact_share.safeParse({
        id: 'artifact_1',
        agent: 'ag_Bu1lder000000001',
        agent_access: { build: true, data: 'read' },
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.artifact_share.safeParse({ id: 'artifact_1', agent: 'ag_Bu1lder000000001' })
        .success,
    ).toBe(false);
  });
});
