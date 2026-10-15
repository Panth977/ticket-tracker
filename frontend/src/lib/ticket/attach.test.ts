import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTACH_TEMPLATE, type BucketOut } from '@tm/shared';
import {
  attachPathProblems,
  defaultBucketId,
  examplePath,
  isWriteGranted,
  prefillPath,
  attachLabel,
  resolveAttachPath,
  templateFor,
  toBucketUploads,
  writeBuckets,
  type BoardBucketOut,
} from './attach';

const mem = (id: string, over: Partial<BoardBucketOut> = {}): BoardBucketOut => ({
  id,
  name: id,
  description: null,
  icon: null,
  indicator: { kind: 'emoji', emoji: '🧠' },
  reach: 'read',
  archived: false,
  stats: { files: 0, folders: 0, bytes: 0 },
  updatedAt: 0,
  ...over,
});

// 2026-10-05 21:19:46 UTC
const AT = Date.UTC(2026, 9, 5, 21, 19, 46);

describe('which buckets a ticket file may go into', () => {
  it('trusts the board grant when the server sends it', () => {
    expect(isWriteGranted(mem('a', { boardGrant: 'write' }), null)).toBe(true);
    expect(isWriteGranted(mem('a', { boardGrant: 'read', reach: 'manage' }), null)).toBe(false);
  });
  it('otherwise: write reach, or the board default (always write-granted)', () => {
    expect(isWriteGranted(mem('a', { reach: 'write' }), null)).toBe(true);
    expect(isWriteGranted(mem('a'), null)).toBe(false);
    expect(isWriteGranted(mem('a'), { bucketId: 'a', template: 'x' })).toBe(true);
  });
  it('never an archived bucket', () => {
    expect(isWriteGranted(mem('a', { boardGrant: 'write', archived: true }), null)).toBe(false);
  });
  it('filters a list', () => {
    const list = [mem('a', { boardGrant: 'read' }), mem('b', { boardGrant: 'write' })];
    expect(writeBuckets(list, null).map((m) => m.id)).toEqual(['b']);
  });
});

describe('the dialog starts on…', () => {
  const list = [mem('a'), mem('b')] as BucketOut[];
  it("the board's default bucket when it is still there", () => {
    expect(defaultBucketId(list, { bucketId: 'b', template: 'x' })).toBe('b');
  });
  it('the first bucket otherwise', () => {
    expect(defaultBucketId(list, { bucketId: 'gone', template: 'x' })).toBe('a');
    expect(defaultBucketId(list, null)).toBe('a');
    expect(defaultBucketId([], null)).toBeNull();
  });
  it("uses the board's template only for its default bucket", () => {
    const am = { bucketId: 'b', template: 'files/<filename>' };
    expect(templateFor('b', am)).toBe('files/<filename>');
    expect(templateFor('a', am)).toBe(DEFAULT_ATTACH_TEMPLATE);
    expect(templateFor('a', null)).toBe(DEFAULT_ATTACH_TEMPLATE);
  });
});

describe('prefilled paths', () => {
  it('fills the template, shows a leading slash and selects the file name', () => {
    const p = prefillPath(DEFAULT_ATTACH_TEMPLATE, {
      ticketKey: 'ENG-42',
      at: AT,
      random6: 'abc123',
      filename: 'photo.png',
    });
    expect(p.value).toBe('/tickets/ENG-42/20261005-211946_photo.png');
    expect(p.value.slice(...p.select!)).toBe('photo.png');
  });
  it('a template without <filename> selects nothing', () => {
    const p = prefillPath('x/<random6>.<exe>', {
      ticketKey: 'ENG-1',
      at: AT,
      random6: 'abc123',
      filename: 'a.pdf',
    });
    expect(p).toEqual({ value: '/x/abc123.pdf', select: null });
  });
  it('a template that no longer fills falls back to the default', () => {
    const p = prefillPath('<nope>', {
      ticketKey: 'ENG-1',
      at: AT,
      random6: 'abc123',
      filename: 'a.pdf',
    });
    expect(p.value).toBe('/tickets/ENG-1/20261005-211946_a.pdf');
  });
});

describe('typed paths', () => {
  it('resolve without the leading slash', () => {
    expect(resolveAttachPath(' /a//b.png ')).toBe('a/b.png');
    expect(resolveAttachPath('/')).toBeNull();
  });
  it('refuses empty, dot segments, angle brackets and duplicates', () => {
    expect(attachPathProblems(['/a.png', '', '/x/../y', '/<ticketId>/a', 'a.png'])).toEqual([
      null,
      'Give it a path',
      "'.' and '..' aren't allowed",
      "A path can't hold '<' or '>'",
      'Two files would get the same path',
    ]);
  });
});

describe('board settings example', () => {
  it('shows what one file becomes', () => {
    expect(examplePath(DEFAULT_ATTACH_TEMPLATE, 'ENG', AT)).toBe(
      '/tickets/ENG-42/20261005-211946_photo.png',
    );
    expect(examplePath('<bad>', 'ENG', AT)).toBeNull();
  });
});

describe('bucketUploads', () => {
  it('sends every upload headed for a bucket, and nothing else', () => {
    expect(
      toBucketUploads([
        {
          path: 'buckets/m1/f1/a.png',
          bucketId: 'm1',
          bucketPath: 'tickets/ENG-1/a.png',
        },
        { path: 'boards/b/tickets/t/x/old.png' },
      ]),
    ).toEqual([
      { bucketId: 'm1', path: 'tickets/ENG-1/a.png', storagePath: 'buckets/m1/f1/a.png' },
    ]);
  });
});

describe('attachLabel: the name the ticket shows', () => {
  const pre = prefillPath('tickets/<ticketId>/<time>_<filename>', {
    ticketKey: 'ENG-1',
    at: Date.UTC(2026, 9, 5, 21, 19, 46),
    random6: 'abc123',
    filename: 'a.png',
  });
  it('is the <filename> part as the person left it', () => {
    expect(attachLabel(pre, pre.value)).toBe('a.png');
    expect(attachLabel(pre, '/tickets/ENG-1/20261005-211946_invoice.pdf')).toBe('invoice.pdf');
  });
  it('falls back to the last segment when the path was reworked', () => {
    expect(attachLabel(pre, '/elsewhere/b.txt')).toBe('b.txt');
  });
});
