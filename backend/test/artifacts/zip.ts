/**
 * A zip WRITER for the artifact tests — real archives (deflate or store) that
 * can also be made to LIE, because the publish pipeline is tested against the
 * zips an honest tool never produces: a declared size smaller than what
 * inflates (the zip bomb), a name that climbs out of the folder (zip-slip),
 * an entry that is a symlink.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/commands/accountExportJob.js';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  /** Default 'deflate' — what `zip -r` and the SDK produce. */
  method?: 'store' | 'deflate';
  /** Write this as the uncompressed size instead of the truth. */
  declaredSize?: number;
  /** Unix mode for the central directory (0o120777 = a symlink). Default a regular file. */
  mode?: number;
}

export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data);
    const deflate = (e.method ?? 'deflate') === 'deflate';
    const body = deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

/** A small, honest site: index.html, a module script, a stylesheet. */
export const SITE: ZipEntrySpec[] = [
  {
    name: 'index.html',
    data: '<!doctype html><title>Hi</title><link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/app.js"></script>',
  },
  { name: 'assets/app.js', data: 'document.title = "hello";\n' },
  { name: 'assets/app.css', data: 'body { margin: 0 }\n' },
];
