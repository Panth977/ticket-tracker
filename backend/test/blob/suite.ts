/**
 * THE FILE-STORAGE PORT CONFORMANCE SUITE — one set of expectations, run
 * against every blob adapter:
 *
 *   test/blob/port.test.ts       disk, in a temp directory (unit project)
 *   test/blob/port.emu.test.ts   Cloud Storage, on the emulator (the reference)
 *
 * Every case writes under its own unique prefix.
 */
import { describe, expect, it } from 'vitest';
import type { Bucket } from '../../src/blob/types.js';

let n = 0;
const uniq = (p: string) =>
  `${p}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

/**
 * `signs`: false where the store cannot sign URLs (the Storage emulator has
 * no service account). `preconditions`: false where generation preconditions
 * are ignored (the Storage emulator; Cloud Storage itself honours them).
 */
export function blobSuite(
  label: string,
  bucket: () => Bucket,
  opts: { signs: boolean; preconditions: boolean },
): void {
  describe(`blob port: ${label}`, () => {
    it('save / exists / download / getMetadata / delete', async () => {
      const f = bucket().file(`${uniq('t')}/a b/hello.txt`);
      expect((await f.exists())[0]).toBe(false);
      await f.save(Buffer.from('hello world'), {
        contentType: 'text/plain',
        resumable: false,
        metadata: { metadata: { k: 'v' } },
      });
      expect((await f.exists())[0]).toBe(true);
      expect((await f.download())[0].toString()).toBe('hello world');
      const [m] = await f.getMetadata();
      expect(Number(m.size)).toBe(11);
      expect(m.contentType).toBe('text/plain');
      expect(m.metadata?.k).toBe('v');
      expect(Date.parse(String(m.timeCreated))).toBeGreaterThan(Date.now() - 600_000);
      await f.delete();
      expect((await f.exists())[0]).toBe(false);
    });

    it('missing objects: 404 errors, ignoreNotFound', async () => {
      const f = bucket().file(`${uniq('t')}/nope.bin`);
      await expect(f.getMetadata()).rejects.toMatchObject({ code: 404 });
      await expect(f.download()).rejects.toMatchObject({ code: 404 });
      await expect(f.delete()).rejects.toMatchObject({ code: 404 });
      await f.delete({ ignoreNotFound: true });
    });

    it('overwrite replaces bytes, type and custom metadata', async () => {
      const f = bucket().file(`${uniq('t')}/x.bin`);
      await f.save(Buffer.from('one'), {
        contentType: 'text/plain',
        metadata: { metadata: { a: '1' } },
      });
      await f.save(Buffer.from('second'), { contentType: 'application/json' });
      const [m] = await f.getMetadata();
      expect((await f.download())[0].toString()).toBe('second');
      expect(m.contentType).toBe('application/json');
      expect(m.metadata?.a).toBeUndefined();
    });

    it('setMetadata merges custom metadata; null removes', async () => {
      const f = bucket().file(`${uniq('t')}/m.png`);
      await f.save(Buffer.from([1, 2, 3]), {
        contentType: 'image/png',
        metadata: { metadata: { a: '1', b: '2' } },
      });
      await f.setMetadata({ metadata: { b: null, c: '3' } });
      const [m] = await f.getMetadata();
      expect(m.metadata).toMatchObject({ a: '1', c: '3' });
      expect(m.metadata?.b).toBeUndefined();
      expect(m.contentType).toBe('image/png');
    });

    it('createReadStream: whole object and an inclusive range', async () => {
      const f = bucket().file(`${uniq('t')}/r.txt`);
      await f.save(Buffer.from('0123456789'), { contentType: 'text/plain' });
      expect((await streamToBuffer(f.createReadStream())).toString()).toBe('0123456789');
      expect((await streamToBuffer(f.createReadStream({ start: 2, end: 5 }))).toString()).toBe(
        '2345',
      );
    });

    it('getFiles by prefix (sorted, with metadata), maxResults, deleteFiles', async () => {
      const root = uniq('p');
      const names = [
        `${root}/b/2.txt`,
        `${root}/a/1.txt`,
        `${root}/a/10.txt`,
        `${root}x/other.txt`,
      ];
      for (const name of names)
        await bucket().file(name).save(Buffer.from(name), { contentType: 'text/plain' });
      const [files] = await bucket().getFiles({ prefix: `${root}/` });
      expect(files.map((f) => f.name)).toEqual([
        `${root}/a/1.txt`,
        `${root}/a/10.txt`,
        `${root}/b/2.txt`,
      ]);
      expect(Number(files[0]!.metadata.size)).toBe(`${root}/a/1.txt`.length);
      expect(files[0]!.metadata.contentType).toBe('text/plain');
      const [partial] = await bucket().getFiles({ prefix: `${root}/a/1` });
      expect(partial.map((f) => f.name)).toEqual([`${root}/a/1.txt`, `${root}/a/10.txt`]);
      const [two] = await bucket().getFiles({
        prefix: `${root}/`,
        maxResults: 2,
        autoPaginate: false,
      });
      expect(two).toHaveLength(2);
      await bucket().deleteFiles({ prefix: `${root}/a/`, force: true });
      const [left] = await bucket().getFiles({ prefix: root });
      expect(left.map((f) => f.name)).toEqual([`${root}/b/2.txt`, `${root}x/other.txt`]);
    });

    it.skipIf(!opts.preconditions)(
      'generation: changes on rewrite; ifGenerationMatch refuses a stale or missing object (412)',
      async () => {
        const f = bucket().file(`${uniq('g')}/a.bin`);
        await f.save(Buffer.from('one'), { contentType: 'text/plain' });
        const g1 = (await f.getMetadata())[0].generation;
        expect(g1).toBeTruthy();
        await f.save(Buffer.from('two'), {
          contentType: 'text/plain',
          preconditionOpts: { ifGenerationMatch: g1! },
        });
        const g2 = (await f.getMetadata())[0].generation;
        expect(String(g2)).not.toBe(String(g1));
        await expect(
          f.save(Buffer.from('three'), { preconditionOpts: { ifGenerationMatch: g1! } }),
        ).rejects.toMatchObject({ code: 412 });
        expect((await f.download())[0].toString()).toBe('two');
        await f.delete();
        await expect(
          f.save(Buffer.from('back'), { preconditionOpts: { ifGenerationMatch: g2! } }),
        ).rejects.toMatchObject({ code: 412 });
        expect((await f.exists())[0]).toBe(false);
      },
    );

    it('copy', async () => {
      const root = uniq('c');
      const a = bucket().file(`${root}/a.txt`);
      await a.save(Buffer.from('copy me'), { contentType: 'text/plain' });
      await a.copy(bucket().file(`${root}/b.txt`));
      const b = bucket().file(`${root}/b.txt`);
      expect((await b.download())[0].toString()).toBe('copy me');
      expect((await b.getMetadata())[0].contentType).toBe('text/plain');
    });

    it.skipIf(!opts.signs)('a signed read URL is minted for an object', async () => {
      const f = bucket().file(`${uniq('s')}/doc.txt`);
      await f.save(Buffer.from('x'), { contentType: 'text/plain' });
      const [url] = await f.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 60_000,
      });
      expect(url).toMatch(/^https?:\/\//);
    });
  });
}
