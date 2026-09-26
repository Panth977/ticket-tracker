import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOC_SCHEMAS, type DocName } from './index.js';
import { fixtures, invalidFixtures } from './fixtures.js';
import {
  FilterNodeSchema,
  TicketKeySchema,
  BoardKeySchema,
  ChannelMatrixSchema,
  defaultChannelMatrix,
} from '../types/index.js';

const specDb = (f: 'app' | 'platform') =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../docs/data/${f}/db.json`, import.meta.url)),
      'utf8',
    ),
  ) as {
    types: { name: string }[];
    schema: { name: string; service: string }[];
  };

describe('document schemas', () => {
  const names = Object.keys(DOC_SCHEMAS) as DocName[];

  it.each(names)('%s: valid fixture parses', (name) => {
    const r = DOC_SCHEMAS[name].safeParse(fixtures[name]);
    if (!r.success) throw new Error(`${name}: ${JSON.stringify(r.error.issues, null, 2)}`);
  });

  it.each(names)('%s: invalid fixture fails', (name) => {
    expect(DOC_SCHEMAS[name].safeParse(invalidFixtures[name]).success).toBe(false);
  });

  it('covers every stored entity in the spec (except Storage files and bare RTDB counters)', () => {
    const spec = [...specDb('app').schema, ...specDb('platform').schema]
      .filter((s) => !/storage/i.test(s.service))
      .map((s) => s.name)
      .filter((n) => n !== 'rateLimits');
    const missing = spec.filter((n) => !(n in DOC_SCHEMAS));
    expect(missing).toEqual([]);
  });
});

describe('primitive types', () => {
  it('board and ticket keys', () => {
    expect(BoardKeySchema.safeParse('ENG').success).toBe(true);
    expect(BoardKeySchema.safeParse('E').success).toBe(false);
    expect(BoardKeySchema.safeParse('ENGINEE').success).toBe(false);
    expect(BoardKeySchema.safeParse('1NG').success).toBe(false);
    expect(TicketKeySchema.safeParse('ENG-42').success).toBe(true);
    expect(TicketKeySchema.safeParse('ENG-0').success).toBe(false);
    expect(TicketKeySchema.safeParse('ENG42').success).toBe(false);
  });

  it('filter tree: nested groups, custom fields, unknown fields rejected', () => {
    const ok = FilterNodeSchema.safeParse({
      op: 'or',
      children: [
        { op: 'and', children: [{ field: 'stage', cmp: 'in', value: ['a'] }] },
        { field: 'fields.f_abc123', cmp: 'empty' },
      ],
    });
    expect(ok.success).toBe(true);
    expect(FilterNodeSchema.safeParse({ field: 'color', cmp: 'is', value: 'x' }).success).toBe(
      false,
    );
    expect(FilterNodeSchema.safeParse({ field: 'stage', cmp: 'like', value: 'x' }).success).toBe(
      false,
    );
  });

  it('default channel matrix follows the spec', () => {
    const m = defaultChannelMatrix();
    expect(ChannelMatrixSchema.parse(m)).toEqual(m);
    expect(m.mentioned).toEqual(['inApp', 'push', 'email']);
    expect(m.overdue).toEqual(['inApp', 'push', 'email']);
    expect(m.comment).toEqual(['inApp']);
    expect(Object.values(m).some((c) => c.includes('whatsapp'))).toBe(false);
  });

  it('every spec type name has a schema or type export', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    const names = [...specDb('app').types, ...specDb('platform').types].map((t) => t.name);
    // TicketKey entry also declares BoardKey; TS-only names are checked by the compiler.
    const missing = names.filter((n) => !(`${n}Schema` in mod) && !['Envelope'].includes(n));
    expect(missing).toEqual([]);
  });
});
