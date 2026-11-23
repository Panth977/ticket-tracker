// @ts-nocheck
// Vendored VERBATIM from the TSVG reference web engine, version 0.1
// (TSVG repository, web/tsvg-zip.js @ 991e4f6). Do not edit here: update
// the source and copy it again. Shipped as text (?raw) into the sandboxed
// player frame (../frame.ts); never imported as a module by the app.

// TSVG package (.tsvgz) = a plain zip: main.tsvg at the root + the files it references.
// Minimal reader/writer, no dependencies. Inflate uses DecompressionStream('deflate-raw')
// in browsers, or the deflateRaw/inflateRaw functions you pass in (Node's zlib).
(function (root) {
  'use strict';
  const MAIN = 'main.tsvg';
  let CRC;
  function crc32(buf) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);

  async function inflate(data, inflateRaw) {
    if (inflateRaw) return inflateRaw(data);
    if (typeof DecompressionStream === 'undefined') throw new Error('this platform cannot inflate zip entries');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([data]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  // → Map(path → Uint8Array)
  async function read(bytes, { inflateRaw } = {}) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file (.tsvgz)');
    const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
      const name = dec(b.subarray(p + 46, p + 46 + nlen));
      const lnlen = v.getUint16(off + 26, true), lxlen = v.getUint16(off + 28, true);
      const data = b.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
      if (!name.endsWith('/')) {
        if (method === 0) files.set(name, data.slice());
        else if (method === 8) files.set(name, await inflate(data, inflateRaw));
        else throw new Error('zip entry ' + name + ': unsupported compression ' + method);
      }
      p += 46 + nlen + xlen + clen;
    }
    if (!files.has(MAIN)) throw new Error('package has no ' + MAIN);
    return files;
  }

  // entries: [{ path, data: Uint8Array|string }]; deflateRaw optional (text gets compressed when given)
  function write(entries, { deflateRaw } = {}) {
    const parts = [], central = []; let off = 0;
    const now = new Date(); const dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1); const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const sorted = entries.slice().sort((a, b) => (a.path === MAIN ? -1 : b.path === MAIN ? 1 : a.path < b.path ? -1 : 1));
    for (const e of sorted) {
      const raw = typeof e.data === 'string' ? enc(e.data) : e.data;
      const compressible = deflateRaw && /\.(tsvg|xml|json|svg|txt|vtt|ttf|otf)$/i.test(e.path);
      const body = compressible ? deflateRaw(raw) : raw; const method = compressible ? 8 : 0;
      const name = enc(e.path); const crc = crc32(raw);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true); h.setUint16(10, dtime, true); h.setUint16(12, ddate, true);
      h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(12, dtime, true); c.setUint16(14, ddate, true);
      c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), name, body); central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + body.length;
    }
    const csize = central.reduce((s, x) => s + x.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, sorted.length, true); e.setUint16(10, sorted.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }
  const isZip = (b) => b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;

  root.TSVGZip = { MAIN, read, write, crc32, isZip, text: dec };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TSVGZip;
})(typeof window !== 'undefined' ? window : globalThis);
