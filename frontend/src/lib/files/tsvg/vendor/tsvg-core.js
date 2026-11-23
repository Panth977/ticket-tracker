// @ts-nocheck
// Vendored VERBATIM from the TSVG reference web engine, version 0.1
// (TSVG repository, web/tsvg-core.js @ 1e89916). Do not edit here: update
// the source and copy it again. Shipped as text (?raw) into the sandboxed
// player frame (../frame.ts); never imported as a module by the app.

// TSVG core: XML parser, expression language, timeline, Canvas2D renderer and validator.
// Reference engine for TSVG 0.1 (Timeseries Scalable Vector Graphics).
// No dependencies, no DOM needed for parse/validate (runs in Node and browsers).
// A frame is a pure function of (time, options): renderFrame(ctx, doc, t, opts, layout)
// always draws the same picture. That is what makes seeking, ±10 s skip and scrub
// thumbnails free, and what lets every native engine be tested against golden frames.
(function (root) {
  'use strict';
  const VERSION = '0.1';

  // ───────────────────────── XML (subset) ─────────────────────────
  // Elements, attributes, text, comments, <?…?>, <!…>, CDATA, the 5 named
  // entities and numeric ones. Enough for TSVG; tiny to port.
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unent = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] != null ? ENT[e] : m));
  function parseXML(src) {
    let i = 0, line = 1;
    const fail = (msg) => { throw new Error('XML line ' + (src.slice(0, i).split('\n').length) + ': ' + msg); };
    const rootEl = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootEl];
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      const textEnd = lt < 0 ? src.length : lt;
      if (textEnd > i) { const top = stack[stack.length - 1]; top.text += unent(src.slice(i, textEnd)); i = textEnd; continue; }
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e < 0) fail('unclosed comment'); i = e + 3; continue; }
      if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i); if (e < 0) fail('unclosed CDATA'); stack[stack.length - 1].text += src.slice(i + 9, e); i = e + 3; continue; }
      if (src.startsWith('<?', i) || src.startsWith('<!', i)) { const e = src.indexOf('>', i); if (e < 0) fail('unclosed declaration'); i = e + 1; continue; }
      if (src.startsWith('</', i)) {
        const m = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(src.slice(i, i + 200)); if (!m) fail('bad closing tag');
        const top = stack.pop(); if (!top || top.name !== m[1]) fail('expected </' + (top && top.name) + '> but found </' + m[1] + '>');
        i += m[0].length; continue;
      }
      const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(i, i + 200)); if (!m) fail('bad tag');
      const el = { name: m[1], attrs: {}, children: [], text: '', line: src.slice(0, i).split('\n').length };
      i += m[0].length;
      for (;;) {
        const ws = /^\s*/.exec(src.slice(i, i + 1000))[0]; i += ws.length;
        if (src.startsWith('/>', i)) { i += 2; stack[stack.length - 1].children.push(el); break; }
        if (src[i] === '>') { i++; stack[stack.length - 1].children.push(el); stack.push(el); break; }
        const a = /^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(i, i + 100000));
        if (!a) fail('bad attribute in <' + el.name + '>');
        if (a[1] in el.attrs) fail('duplicate attribute ' + a[1] + ' in <' + el.name + '>');
        el.attrs[a[1]] = unent(a[3] != null ? a[3] : a[4]); i += a[0].length;
      }
    }
    if (stack.length > 1) fail('unclosed <' + stack[stack.length - 1].name + '>');
    const els = rootEl.children; if (els.length !== 1) fail('expected exactly one root element');
    return els[0];
  }

  // ───────────────────────── expression language ─────────────────────────
  const PI = Math.PI;
  const EASE = {
    linear: (k) => k,
    in: (k) => k * k * k,
    out: (k) => 1 - Math.pow(1 - k, 3),
    io: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    back: (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
    elastic: (k) => (k === 0 || k === 1 ? k : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * (2 * PI / 3)) + 1),
    step: (k) => (k < 1 ? 0 : 1),
  };
  const FNS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, sqrt: Math.sqrt,
    min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    pow: Math.pow, exp: Math.exp, log: Math.log, atan2: Math.atan2, sign: Math.sign,
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    lerp: (a, b, k) => a + (b - a) * k,
    step: (e, x) => (x < e ? 0 : 1),
    smooth: (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); },
    fract: (x) => x - Math.floor(x),
    ease: (k, name) => (EASE[name] || EASE.linear)(Math.min(1, Math.max(0, k))),
    fmt: (n, d) => Number(n).toFixed(d || 0),
    str: (x) => String(x),
    rgba: (r, g, b, a) => 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + (a == null ? 1 : a) + ')',
    mix: (a, b, k) => lerpAny(a, b, k),
  };

  function tokenize(src) {
    const out = []; let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) { const m = /^[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?/i.exec(src.slice(i)); if (!m) throw new Error('bad number in ' + src); out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (/[A-Za-z_$]/.test(c)) { const m = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); out.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if (c === "'" || c === '"') { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error('unclosed string in ' + src); out.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue; }
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/%^<>!?:(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error("bad character '" + c + "' in " + src);
    }
    return out;
  }
  const BP = { '?': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 8 };
  const BIN = {
    '+': (x, y) => (typeof x === 'string' || typeof y === 'string' ? String(x) + String(y) : x + y),
    '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y,
    '%': (x, y) => ((x % y) + y) % y, '^': (x, y) => Math.pow(x, y),
    '==': (x, y) => (x == y ? 1 : 0), '!=': (x, y) => (x != y ? 1 : 0),
    '<': (x, y) => (x < y ? 1 : 0), '>': (x, y) => (x > y ? 1 : 0), '<=': (x, y) => (x <= y ? 1 : 0), '>=': (x, y) => (x >= y ? 1 : 0),
  };
  function compile(src) {
    const toks = tokenize(src); let p = 0;
    const peek = () => toks[p]; const next = () => toks[p++];
    const expect = (v) => { const k = next(); if (!k || k.v !== v) throw new Error("expected '" + v + "' in " + src); };
    function prefix() {
      const k = next(); if (!k) throw new Error('unexpected end of ' + src);
      if (k.t === 'num' || k.t === 'str') { const v = k.v; return () => v; }
      if (k.t === 'op' && k.v === '(') { const e = expr(0); expect(')'); return e; }
      if (k.t === 'op' && k.v === '-') { const e = expr(9); return (env) => -e(env); }
      if (k.t === 'op' && k.v === '!') { const e = expr(9); return (env) => (e(env) ? 0 : 1); }
      if (k.t === 'id') {
        const name = k.v;
        if (peek() && peek().v === '(') {
          next(); const args = [];
          if (peek() && peek().v !== ')') { do { args.push(expr(0)); } while (peek() && peek().v === ',' && next()); }
          expect(')');
          return (env) => {
            const vals = args.map((a) => a(env));
            if (FNS[name]) return FNS[name].apply(null, vals);
            const f = env.fns && env.fns[name]; if (!f) throw new Error('unknown function ' + name + '()');
            return f(vals, env);
          };
        }
        if (name === 'PI') return () => PI;
        if (name === 'true') return () => 1;
        if (name === 'false') return () => 0;
        return (env) => lookup(env, name);
      }
      throw new Error("unexpected '" + k.v + "' in " + src);
    }
    function expr(rbp) {
      let left = prefix();
      for (;;) {
        const k = peek(); if (!k || k.t !== 'op' || !(k.v in BP) || BP[k.v] <= rbp) break;
        next(); const op = k.v;
        if (op === '?') { const a = expr(0); expect(':'); const b = expr(0); const c = left; left = (env) => (c(env) ? a(env) : b(env)); continue; }
        const right = expr(op === '^' ? BP[op] - 1 : BP[op]); const l = left;
        if (op === '&&') left = (e) => (l(e) && right(e) ? 1 : 0);
        else if (op === '||') left = (e) => (l(e) || right(e) ? 1 : 0);
        else { const f = BIN[op]; left = (e) => f(l(e), right(e)); }
      }
      return left;
    }
    const e = expr(0); if (p < toks.length) throw new Error("unexpected '" + toks[p].v + "' in " + src); return e;
  }
  function lookup(env, name) {
    if (name[0] === '$') { const v = env.theme[name.slice(1)]; if (v === undefined) throw new Error('unknown theme token ' + name); return v; }
    if (name in env.vars) return env.vars[name];
    if (name in env.opts) return env.opts[name];
    throw new Error('unknown variable ' + name);
  }

  // ───────────────────────── document model ─────────────────────────
  const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'path', 'text', 'image', 'group', 'use']);
  const NUMERIC = /^-?[0-9]*\.?[0-9]+$/;
  const AUDIO_EXT = /\.(ogg|opus|mp3|m4a|wav|aac|flac)$/i;
  const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

  function parse(xml) {
    const r = parseXML(xml);
    if (r.name !== 'tsvg') throw new Error('root element must be <tsvg>, found <' + r.name + '>');
    const kids = (el, name) => el.children.filter((c) => !name || c.name === name);
    const one = (name) => kids(r, name)[0];
    const doc = {
      version: r.attrs.version || VERSION, title: r.attrs.title || '', font: r.attrs.font || '', layouts: [], options: [], mixes: {}, themes: {}, strings: {},
      fns: {}, fnSrc: {}, symbols: {}, gradients: {}, clips: {}, masks: {}, assets: {}, fonts: [], scenes: [], backdrop: [], overlay: [],
      audio: [], says: [], voices: {}, chapters: [], duration: 0, warnings: [],
    };
    for (const l of kids(one('layouts') || r, 'layout')) doc.layouts.push({ id: l.attrs.id, w: +l.attrs.w, h: +l.attrs.h });
    if (!doc.layouts.length) doc.layouts.push({ id: 'landscape', w: 1920, h: 1080 });
    for (const o of kids(one('options') || r, 'option')) doc.options.push({ id: o.attrs.id, label: o.attrs.label || o.attrs.id, default: o.attrs.default, choices: kids(o, 'choice').map((c) => ({ id: c.attrs.id, label: c.attrs.label || c.attrs.id })) });
    for (const m of kids(one('mixes') || r, 'mix')) { const g = {}; for (const k in m.attrs) if (k !== 'id') g[k] = +m.attrs[k]; doc.mixes[m.attrs.id] = g; }
    for (const th of kids(one('themes') || r, 'theme')) { const a = Object.assign({}, th.attrs); delete a.id; doc.themes[th.attrs.id] = a; }
    for (const s of kids(one('strings') || r, 's')) { const a = Object.assign({}, s.attrs); delete a.id; doc.strings[s.attrs.id] = a; }
    const defs = one('defs');
    if (defs) for (const d of defs.children) {
      const id = d.attrs.id;
      if (d.name === 'fn') {
        const args = (d.attrs.args || '').split(',').map((s) => s.trim()).filter(Boolean); const src = d.text.trim(); const body = compile(src);
        doc.fnSrc[id] = { args, src };
        doc.fns[id] = (vals, env) => { const vars = Object.assign({}, env.vars); args.forEach((n, i) => (vars[n] = vals[i])); return body(Object.assign({}, env, { vars })); };
      } else if (d.name === 'symbol') doc.symbols[id] = buildNodes(d);
      else if (d.name === 'linear' || d.name === 'radial') doc.gradients[id] = { type: d.name, a: d.attrs, stops: kids(d, 'stop').map((s) => s.attrs) };
      else if (d.name === 'clip') doc.clips[id] = buildNodes(d);
      else if (d.name === 'mask') doc.masks[id] = buildNodes(d);
    }
    for (const a of kids(one('assets') || r)) {
      if (a.name === 'font') doc.fonts.push({ id: a.attrs.id, family: a.attrs.family || a.attrs.id, src: a.attrs.src, weight: a.attrs.weight || '400', style: a.attrs.style || 'normal' });
      else if (a.name === 'asset') doc.assets[a.attrs.id] = { src: a.attrs.src, type: a.attrs.type || guessType(a.attrs.src) };
    }
    for (const v of kids(one('voices') || r, 'voice')) doc.voices[v.attrs.say + '|' + v.attrs.lang] = { src: v.attrs.src, dur: +v.attrs.dur || 0, hash: v.attrs.hash || '', engine: v.attrs.engine || '' };
    for (const m of kids(r, 'music')) doc.audio.push({ bus: m.attrs.bus || 'music', src: m.attrs.src, start: +(m.attrs.start || 0), loop: m.attrs.loop === '1', vol: +(m.attrs.vol || 1), when: m.attrs.when });
    const bd = one('backdrop'); if (bd) doc.backdrop = buildNodes(bd);
    const ov = one('overlay'); if (ov) doc.overlay = buildNodes(ov);
    let cursor = 0;
    for (const sc of kids(one('timeline') || r, 'scene')) {
      const start = sc.attrs.start != null ? +sc.attrs.start : cursor;
      const dur = +sc.attrs.dur; if (!(dur > 0)) throw new Error('<scene id="' + sc.attrs.id + '"> needs dur > 0');
      doc.scenes.push({ id: sc.attrs.id, start, dur, nodes: buildNodes(sc) });
      if (sc.attrs.chapter) doc.chapters.push({ t: start, label: sc.attrs.chapter });
      walk(sc, (el) => {
        if (el.name === 'say') {
          const key = el.attrs.id || (el.attrs.text && el.attrs.text[0] === '@' ? el.attrs.text.slice(1) : 'say' + doc.says.length);
          doc.says.push({ key, start: start + +(el.attrs.at || 0), raw: el.attrs, scene: sc.attrs.id });
        }
        if (el.name === 'sfx') doc.audio.push({ bus: el.attrs.bus || 'sfx', src: el.attrs.src, start: start + +(el.attrs.at || 0), vol: +(el.attrs.vol || 1), when: el.attrs.when });
      });
      cursor = start + dur; doc.duration = Math.max(doc.duration, cursor);
    }
    if (r.attrs.duration) doc.duration = +r.attrs.duration;
    return doc;

    function walk(el, f) { for (const c of el.children) { f(c); walk(c, f); } }
    function buildNodes(el) {
      const out = [];
      for (const c of el.children) {
        if (!SHAPES.has(c.name)) continue;
        const node = { type: c.name, a: c.attrs, anims: [], children: [], line: c.line };
        for (const k of c.children) {
          if (k.name === 'anim') node.anims.push({ prop: k.attrs.prop, a: k.attrs });
          else if (k.name === 'keys') node.anims.push({ prop: k.attrs.prop, keys: parseKeys(k.attrs.v || k.text), ease: k.attrs.ease || 'io' });
        }
        if (c.name === 'group') node.children = buildNodes(c);
        out.push(node);
      }
      return out;
    }
  }
  function guessType(src) { return AUDIO_EXT.test(src || '') ? 'audio' : FONT_EXT.test(src || '') ? 'font' : 'image'; }
  function parseKeys(s) { return s.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return { at: +x.slice(0, i), v: x.slice(i + 1).trim() }; }); }

  // ───────────────────────── value resolution ─────────────────────────
  const cache = new Map();
  function compiled(src) { let f = cache.get(src); if (!f) { f = compile(src); cache.set(src, f); } return f; }

  function strOf(doc, id, env) {
    const s = doc.strings[id]; if (!s) throw new Error('unknown string @' + id);
    const lang = env.opts.lang; const v = s[lang] != null ? s[lang] : s.en != null ? s.en : Object.values(s)[0];
    return template(v, env);
  }
  function template(s, env) { return s.indexOf('{') < 0 ? s : s.replace(/\{([^}]+)\}/g, (_, e) => String(compiled(e)(env))); }
  function value(raw, env, doc) {
    if (raw == null) return undefined;
    if (raw[0] === '=') return compiled(raw.slice(1))(env);
    if (raw[0] === '@') return strOf(doc, raw.slice(1), env);
    if (raw[0] === '$' && /^\$[A-Za-z_]\w*$/.test(raw)) return lookup(env, raw);
    if (NUMERIC.test(raw)) return parseFloat(raw);
    return template(raw, env);
  }
  // attribute variants: x.portrait, size.gu, fill.light … first matching tag wins
  function pick(a, name, env) {
    for (const tag of env.tags) { const k = name + '.' + tag; if (k in a) return a[k]; }
    return a[name];
  }
  function attr(node, name, env, doc, dflt) { const v = value(pick(node.a, name, env), env, doc); return v === undefined ? dflt : v; }

  function parseColor(c) {
    if (typeof c !== 'string') return null;
    let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
    m = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(c); if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(m[2] ? parseInt(m[2] + m[2], 16) / 255 : 1);
    m = /^rgba?\(([^)]+)\)$/.exec(c); if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
    return null;
  }
  function lerpAny(a, b, k) {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
    const ca = parseColor(a), cb = parseColor(b);
    if (ca && cb) return 'rgba(' + [0, 1, 2].map((i) => Math.round(ca[i] + (cb[i] - ca[i]) * k)).join(',') + ',' + +(ca[3] + (cb[3] - ca[3]) * k).toFixed(3) + ')';
    return k < 1 ? a : b;
  }
  function withAlpha(c, a) { const p = parseColor(c); if (!p || a >= 1) return c; return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + +(p[3] * a).toFixed(3) + ')'; }

  // property = base attribute, then <anim>/<keys> in order (later started anims win)
  function prop(node, name, env, doc, dflt) {
    let v = attr(node, name, env, doc, dflt);
    let first = true;
    for (const an of node.anims) {
      if (an.prop !== name) continue;
      const lt = env.vars.T - env.vars.T0;
      if (an.keys) {
        const ks = an.keys; const ease = EASE[an.ease] || EASE.io;
        if (lt <= ks[0].at) v = value(ks[0].v, env, doc);
        else if (lt >= ks[ks.length - 1].at) v = value(ks[ks.length - 1].v, env, doc);
        else for (let i = 0; i < ks.length - 1; i++) if (lt >= ks[i].at && lt < ks[i + 1].at) { v = lerpAny(value(ks[i].v, env, doc), value(ks[i + 1].v, env, doc), ease((lt - ks[i].at) / (ks[i + 1].at - ks[i].at))); break; }
        first = false; continue;
      }
      const a = an.a;
      const at = +value(pick(a, 'at', env) || '0', env, doc), dur = +value(pick(a, 'dur', env) || '0.5', env, doc);
      const from = pick(a, 'from', env) != null ? value(pick(a, 'from', env), env, doc) : v;
      const to = pick(a, 'to', env) != null ? value(pick(a, 'to', env), env, doc) : v;
      if (lt < at) { if (first) v = from; }
      else { const k = dur > 0 ? Math.min(1, (lt - at) / dur) : 1; v = lerpAny(from, to, (EASE[a.ease] || EASE.out)(k)); }
      first = false;
    }
    return v;
  }

  // ───────────────────────── rendering ─────────────────────────
  const FONT = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Gujarati', 'Gujarati Sangam MN', sans-serif";
  const pathLen = new Map();
  function lengthOf(d) {
    if (pathLen.has(d)) return pathLen.get(d);
    let L = 1000;
    try { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); L = p.getTotalLength(); } catch (e) {}
    pathLen.set(d, L); return L;
  }

  function makeEnv(doc, opts, layout, t, images) {
    const theme = doc.themes[opts.theme] || Object.values(doc.themes)[0] || {};
    const tags = [layout.id].concat(doc.options.map((o) => opts[o.id]).filter(Boolean));
    return { doc, opts, theme, tags, fns: doc.fns, images, vars: { t, T: t, T0: 0, p: 0, W: layout.w, H: layout.h, dur: doc.duration, portrait: layout.h > layout.w ? 1 : 0, layout: layout.id } };
  }
  function drawNodes(ctx, nodes, env) { for (const n of nodes) drawNode(ctx, n, env); }
  function visible(n, env) {
    const a = n.a;
    const w = pick(a, 'when', env);
    if (w != null && !compiled(w[0] === '=' ? w.slice(1) : w)(env)) return false;
    if (a.only) { const want = a.only.split(/[ ,]+/); if (!want.some((x) => env.tags.includes(x))) return false; }
    const T = env.vars.T;
    const at = a.at != null ? +value(pick(a, 'at', env), env, env.doc) : null;
    if (at != null && T < at) return false;
    if (a.dur != null && T > (at || 0) + +value(pick(a, 'dur', env), env, env.doc)) return false;
    return true;
  }
  // fill/stroke paint: colour, $token, or url(#gradient)
  function paintOf(ctx, v, env, alpha) {
    if (v == null || v === 'none') return null;
    const m = /^url\(#([\w-]+)\)$/.exec(v);
    if (!m) return alpha < 1 ? withAlpha(v, alpha) : v;
    const g = env.doc.gradients[m[1]]; if (!g) throw new Error('unknown gradient #' + m[1]);
    const n = (k, d) => { const r = pick(g.a, k, env); return r == null ? d : +value(r, env, env.doc); };
    const grad = g.type === 'linear' ? ctx.createLinearGradient(n('x1', 0), n('y1', 0), n('x2', 100), n('y2', 0)) : ctx.createRadialGradient(n('fx', n('x', 0)), n('fy', n('y', 0)), 0, n('x', 0), n('y', 0), n('r', 100));
    for (const s of g.stops) grad.addColorStop(Math.min(1, Math.max(0, +value(s.at || '0', env, env.doc))), withAlpha(String(value(s.color || '#000', env, env.doc)), (s.opacity != null ? +value(s.opacity, env, env.doc) : 1) * (alpha == null ? 1 : alpha)));
    return grad;
  }
  // Path2D of a shape node (for clip paths); null when the node has no area
  function shapePath(n, env) {
    const P = (k, d) => prop(n, k, env, env.doc, d);
    const p = new Path2D();
    if (n.type === 'rect') { const w = P('w', 100), h = P('h', 100), x = P('x', 0) - w * P('ax', 0), y = P('y', 0) - h * P('ay', 0), r = P('r', 0); if (r > 0 && p.roundRect) p.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else p.rect(x, y, w, h); return p; }
    if (n.type === 'circle' || n.type === 'ellipse') { const rx = P('r', P('rx', 50)), ry = n.type === 'ellipse' ? P('ry', rx) : rx; p.ellipse(P('x', 0), P('y', 0), Math.max(0, rx), Math.max(0, ry), 0, 0, 2 * PI); return p; }
    if (n.type === 'path') { const q = new Path2D(); const x = P('x', 0), y = P('y', 0); q.addPath(new Path2D(P('d', '')), { a: 1, b: 0, c: 0, d: 1, e: x, f: y }); return q; }
    return null;
  }
  function shadowOf(ctx, raw, env) {
    if (!raw || raw === 'none') return;
    const parts = String(raw).trim().split(/\s+/);
    const k = ctx.getTransform ? Math.sqrt(Math.abs(ctx.getTransform().a * ctx.getTransform().d - ctx.getTransform().b * ctx.getTransform().c)) : 1;
    ctx.shadowOffsetX = +parts[0] * k; ctx.shadowOffsetY = +parts[1] * k; ctx.shadowBlur = +(parts[2] || 0) * k;
    const c = parts[3] || '#0008'; ctx.shadowColor = c[0] === '$' ? lookup(env, c) : c;
  }

  function drawNode(ctx, n, parentEnv) {
    if (!visible(n, parentEnv)) return;
    const doc = parentEnv.doc;
    const env = Object.assign({}, parentEnv, { vars: Object.assign({}, parentEnv.vars, { T0: n.a.at != null ? +value(pick(n.a, 'at', parentEnv), parentEnv, doc) : parentEnv.vars.T0 }) });
    const mask = pick(n.a, 'mask', env);
    if (mask && ctx.canvas && typeof ctx.canvas.getContext === 'function') return drawMasked(ctx, n, env, mask);
    const P = (name, d) => prop(n, name, env, doc, d);
    const opacity = P('opacity', 1); if (opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, opacity);
    const blend = pick(n.a, 'blend', env); if (blend) ctx.globalCompositeOperation = blend;
    const rot = P('rot', 0), scale = P('scale', 1);
    const fillRaw = P('fill', n.type === 'text' ? env.theme.fg || '#fff' : undefined);
    const strokeRaw = P('stroke'), sw = P('sw', 0);
    shadowOf(ctx, P('shadow'), env);
    const pivot = (px, py) => { if (rot || scale !== 1) { ctx.translate(px, py); if (rot) ctx.rotate((rot * PI) / 180); if (scale !== 1) ctx.scale(scale, scale); ctx.translate(-px, -py); } };
    const clipTo = () => {
      const c = pick(n.a, 'clip', env); if (!c) return;
      const m = /^url\(#([\w-]+)\)$/.exec(c); const shapes = m && doc.clips[m[1]]; if (!shapes) throw new Error('unknown clip ' + c);
      const p = new Path2D(); for (const s of shapes) { const sp = shapePath(s, env); if (sp) p.addPath(sp); }
      ctx.clip(p);
    };
    const paint = (path) => {
      const f = paintOf(ctx, fillRaw, env); const s = sw > 0 ? paintOf(ctx, strokeRaw, env) : null;
      if (f) { ctx.fillStyle = f; ctx.fill(path); }
      if (s) { if (f) ctx.shadowColor = 'transparent'; ctx.strokeStyle = s; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(path); }
    };
    switch (n.type) {
      case 'group': case 'use': {
        ctx.translate(P('x', 0), P('y', 0)); pivot(0, 0); clipTo();
        if (n.type === 'use' && !doc.symbols[n.a.ref]) throw new Error('unknown symbol ' + n.a.ref);
        drawNodes(ctx, n.type === 'use' ? doc.symbols[n.a.ref] : n.children, env);
        break;
      }
      case 'rect': {
        const w = P('w', 100), h = P('h', 100), x = P('x', 0) - w * P('ax', 0), y = P('y', 0) - h * P('ay', 0), r = P('r', 0);
        pivot(x + w / 2, y + h / 2); clipTo();
        const p = new Path2D(); if (r > 0 && p.roundRect) p.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else p.rect(x, y, w, h);
        paint(p); break;
      }
      case 'circle': case 'ellipse': {
        const cx = P('x', 0), cy = P('y', 0), rx = P('r', P('rx', 50)), ry = n.type === 'ellipse' ? P('ry', rx) : rx;
        const a0 = P('from', 0), a1 = P('to', 360);
        pivot(cx, cy); clipTo();
        const p = new Path2D(); if (a1 - a0 < 360) p.moveTo(cx, cy);
        p.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, ((a0 - 90) * PI) / 180, ((a1 - 90) * PI) / 180);
        if (a1 - a0 < 360) p.closePath();
        paint(p); break;
      }
      case 'line': {
        const x1 = P('x1', 0), y1 = P('y1', 0), x2 = P('x2', 0), y2 = P('y2', 0), draw = P('draw', 1);
        const p = new Path2D(); p.moveTo(x1, y1); p.lineTo(x1 + (x2 - x1) * draw, y1 + (y2 - y1) * draw);
        ctx.strokeStyle = paintOf(ctx, strokeRaw || fillRaw || env.theme.fg, env); ctx.lineWidth = sw || 4; ctx.lineCap = 'round'; ctx.stroke(p); break;
      }
      case 'path': {
        const d = P('d', ''), draw = P('draw', 1);
        ctx.translate(P('x', 0), P('y', 0)); pivot(0, 0); clipTo();
        const p = new Path2D(d);
        if (draw < 1) { const L = lengthOf(d); ctx.setLineDash([L * draw, L + 1]); }
        const f = draw >= 1 ? paintOf(ctx, fillRaw, env) : null; const s = sw > 0 ? paintOf(ctx, strokeRaw, env) : null;
        if (f) { ctx.fillStyle = f; ctx.fill(p); }
        if (s) { if (f) ctx.shadowColor = 'transparent'; ctx.strokeStyle = s; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(p); }
        break;
      }
      case 'text': {
        let txt = String(value(pick(n.a, 'text', env), env, doc) ?? '');
        const reveal = P('reveal', 1); if (reveal < 1) txt = [...txt].slice(0, Math.round([...txt].length * reveal)).join('');
        const size = P('size', 48), weight = P('weight', 400), x = P('x', 0), y = P('y', 0);
        const align = P('align', 'left'), maxw = P('maxw', 0), lh = P('lh', 1.25), font = P('font', '');
        const fams = String(font || doc.font || '').split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        ctx.font = (P('italic', 0) ? 'italic ' : '') + weight + ' ' + size + 'px ' + fams.map((f) => "'" + f + "', ").join('') + FONT;
        ctx.textAlign = align; ctx.textBaseline = 'middle';
        const lines = maxw > 0 ? wrap(ctx, txt, maxw) : txt.split('\n');
        pivot(x, y); clipTo();
        const y0 = y - ((lines.length - 1) * size * lh) / 2;
        const f = paintOf(ctx, fillRaw, env); const s = sw > 0 ? paintOf(ctx, strokeRaw, env) : null;
        lines.forEach((ln, i) => { const yy = y0 + i * size * lh; if (s) { ctx.strokeStyle = s; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.strokeText(ln, x, yy); } if (f) { ctx.fillStyle = f; ctx.fillText(ln, x, yy); } });
        break;
      }
      case 'image': {
        const img = env.images && env.images[n.a.src];
        const w = P('w', 100), h = P('h', 100), x = P('x', 0) - w * P('ax', 0), y = P('y', 0) - h * P('ay', 0), r = P('r', 0);
        pivot(x + w / 2, y + h / 2); clipTo();
        if (r > 0) { const p = new Path2D(); p.roundRect(x, y, w, h, r); ctx.clip(p); }
        if (img && (img.complete !== false)) {
          const fit = P('fit', 'cover'); const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
          if (fit === 'fill' || !iw) ctx.drawImage(img, x, y, w, h);
          else { const k = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih); const dw = iw * k, dh = ih * k; ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore(); }
        } else { ctx.fillStyle = '#8884'; ctx.fillRect(x, y, w, h); }
        break;
      }
    }
    ctx.restore();
  }
  // mask="url(#m)": draw the node and the mask into offscreen layers, keep node pixels where the mask has alpha
  function drawMasked(ctx, n, env, maskRef) {
    const m = /^url\(#([\w-]+)\)$/.exec(maskRef); const shapes = m && env.doc.masks[m[1]]; if (!shapes) throw new Error('unknown mask ' + maskRef);
    const W = ctx.canvas.width, H = ctx.canvas.height; const tf = ctx.getTransform();
    const mk = () => { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }); const x = c.getContext('2d'); x.setTransform(tf); return [c, x]; };
    const [lc, lx] = mk(); const [mc, mx] = mk();
    lx.globalAlpha = ctx.globalAlpha;
    const plain = Object.assign({}, n, { a: Object.assign({}, n.a, { mask: undefined }) });
    for (const k of Object.keys(plain.a)) if (k.startsWith('mask.')) delete plain.a[k];
    drawNode(lx, plain, env);
    // the mask is drawn in the node's coordinate space (after its x/y for groups)
    if (n.type === 'group' || n.type === 'use' || n.type === 'path') mx.translate(prop(n, 'x', env, env.doc, 0), prop(n, 'y', env, env.doc, 0));
    drawNodes(mx, shapes, env);
    lx.setTransform(1, 0, 0, 1, 0, 0); lx.globalAlpha = 1; lx.globalCompositeOperation = 'destination-in'; lx.drawImage(mc, 0, 0);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(lc, 0, 0); ctx.restore();
  }
  function wrap(ctx, txt, maxw) {
    const out = [];
    for (const para of txt.split('\n')) {
      let line = '';
      for (const w of para.split(' ')) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxw && line) { out.push(line); line = w; } else line = t; }
      out.push(line);
    }
    return out;
  }

  // draw the frame at time t; ctx already maps layout units (layout.w × layout.h) to the target
  function renderFrame(ctx, doc, t, opts, layout, images) {
    const env = makeEnv(doc, opts, layout, t, images);
    ctx.save();
    ctx.fillStyle = paintOf(ctx, env.theme.bg || '#000', env); ctx.fillRect(0, 0, layout.w, layout.h);
    drawNodes(ctx, doc.backdrop, env);
    const last = doc.scenes[doc.scenes.length - 1];
    for (const sc of doc.scenes) {
      const active = (t >= sc.start && t < sc.start + sc.dur) || (sc === last && t >= sc.start + sc.dur);
      if (!active) continue;
      const T = Math.min(t, sc.start + sc.dur - 1e-6) - sc.start;
      drawNodes(ctx, sc.nodes, Object.assign({}, env, { vars: Object.assign({}, env.vars, { T, p: T / sc.dur, sdur: sc.dur }) }));
    }
    drawNodes(ctx, doc.overlay, env);
    ctx.restore();
  }

  // ───────────────────────── audio plan ─────────────────────────
  // Everything an engine needs to play sound for one option set: clips on buses + captions.
  function sayLines(doc, opts) {
    const env = makeEnv(doc, opts, doc.layouts[0], 0, null);
    return doc.says.filter((s) => !s.raw.when || compiled(s.raw.when.replace(/^=/, ''))(env)).map((s) => {
      const text = String(value(s.raw.text, env, doc));
      const baked = doc.voices[s.key + '|' + opts.lang];
      const clip = s.raw['src.' + opts.lang] || (baked && baked.src) || null;
      const dur = baked && baked.dur ? baked.dur : s.raw.dur ? +s.raw.dur : Math.max(1.5, text.split(/\s+/).length * 0.42);
      const sp = s.raw['speak.' + opts.lang] || s.raw.speak; // pronunciation text for TTS (captions keep `text`)
      return { key: s.key, start: s.start, dur, text, speak: sp ? String(value(sp, env, doc)) : text, clip, lang: opts.lang, voice: s.raw.voice };
    });
  }
  function audioPlan(doc, opts) {
    const env = makeEnv(doc, opts, doc.layouts[0], 0, null);
    const mix = doc.mixes[opts.mix] || { voice: 1, music: 1, sfx: 1 };
    const clips = doc.audio.filter((a) => !a.when || compiled(a.when.replace(/^=/, ''))(env)).map((a) => Object.assign({}, a));
    for (const l of sayLines(doc, opts)) if (l.clip) clips.push({ bus: 'voice', src: l.clip, start: l.start, vol: 1 });
    return { mix, clips };
  }
  // asset id or path → path inside the package
  function assetPath(doc, ref) { return ref && doc.assets[ref] ? doc.assets[ref].src : ref; }

  function defaults(doc) { const o = {}; for (const op of doc.options) o[op.id] = op.default || (op.choices[0] && op.choices[0].id); return o; }
  function combos(doc) {
    let out = [{}];
    for (const o of doc.options) { const next = []; for (const c of out) for (const ch of o.choices) next.push(Object.assign({}, c, { [o.id]: ch.id })); out = next; }
    return out;
  }

  // ───────────────────────── validation ─────────────────────────
  // Static checks + a dry run of every frame sample under every option set and layout
  // against a recording context (no canvas needed). files: Set of paths in the package (optional).
  function validate(xml, { files, samples = 4 } = {}) {
    const errors = [], warnings = [];
    let doc;
    try { doc = parse(xml); } catch (e) { return { ok: false, errors: [e.message], warnings, doc: null }; }
    const langs = (doc.options.find((o) => o.id === 'lang') || { choices: [] }).choices.map((c) => c.id);
    for (const [id, s] of Object.entries(doc.strings)) for (const l of langs) if (s[l] == null) warnings.push('string @' + id + ' has no "' + l + '" text (falls back)');
    for (const o of doc.options) if (o.default && !o.choices.some((c) => c.id === o.default)) errors.push('option ' + o.id + ': default "' + o.default + '" is not a choice');
    const mixOpt = doc.options.find((o) => o.id === 'mix'); if (mixOpt) for (const c of mixOpt.choices) if (!doc.mixes[c.id]) errors.push('mix choice "' + c.id + '" has no <mix id="' + c.id + '">');
    const themeOpt = doc.options.find((o) => o.id === 'theme'); if (themeOpt) for (const c of themeOpt.choices) if (!doc.themes[c.id]) errors.push('theme choice "' + c.id + '" has no <theme id="' + c.id + '">');
    const ref = (r, what) => { const p = assetPath(doc, r); if (!p) errors.push(what + ': missing src'); else if (files && !files.has(p) && !/^(https?|data):/.test(p)) errors.push(what + ': file not in package: ' + p); };
    for (const [id, a] of Object.entries(doc.assets)) ref(a.src, 'asset ' + id);
    for (const f of doc.fonts) ref(f.src, 'font ' + f.family);
    for (const a of doc.audio) { if (!doc.assets[a.src] && !/\//.test(a.src || '')) errors.push('audio src "' + a.src + '" is neither an asset id nor a path'); }
    for (const v of Object.values(doc.voices)) ref(v.src, 'voice');
    for (const s of doc.says) for (const l of langs.length ? langs : ['en']) {
      const c = s.raw['src.' + l]; if (c && !doc.assets[c] && !/\//.test(c)) errors.push('say ' + s.key + ': src.' + l + ' "' + c + '" unknown');
    }
    // voice lines that run into the next line (per language)
    for (const l of langs.length ? langs : ['en']) {
      const lines = sayLines(doc, Object.assign(defaults(doc), { lang: l })).sort((a, b) => a.start - b.start);
      lines.forEach((ln, i) => {
        if (!ln.clip) warnings.push('say ' + ln.key + ' [' + l + ']: no recorded clip (engine TTS or captions only) — run `tsvg bake`');
        const next = lines[i + 1]; const end = ln.start + ln.dur;
        if (next && end > next.start + 0.05) warnings.push('say ' + ln.key + ' [' + l + '] ends at ' + end.toFixed(2) + 's, overlaps ' + next.key + ' at ' + next.start.toFixed(2) + 's');
        if (end > doc.duration + 0.05) warnings.push('say ' + ln.key + ' [' + l + '] runs past the end (' + end.toFixed(2) + 's > ' + doc.duration + 's)');
      });
    }
    // dry run
    const ctx = recordingContext();
    const sets = combos(doc); const seen = new Set();
    outer: for (const L of doc.layouts) for (const opts of sets.length ? sets : [{}]) {
      for (let i = 0; i <= samples * doc.scenes.length; i++) {
        const t = (doc.duration * i) / (samples * doc.scenes.length);
        try { renderFrame(ctx, doc, t, Object.assign(defaults(doc), opts), L, null); }
        catch (e) { const k = e.message; if (!seen.has(k)) { seen.add(k); errors.push('render ' + L.id + ' ' + JSON.stringify(opts) + ' t=' + t.toFixed(2) + ': ' + e.message); } if (errors.length > 30) break outer; }
      }
    }
    return { ok: errors.length === 0, errors, warnings, doc, stats: { duration: doc.duration, scenes: doc.scenes.length, layouts: doc.layouts.length, variants: sets.length * doc.layouts.length, says: doc.says.length } };
  }
  function recordingContext() {
    const noop = () => {};
    const grad = { addColorStop: noop };
    const ctx = { canvas: null, globalAlpha: 1, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), fill: noop, stroke: noop, fillRect: noop, fillText: noop, strokeText: noop, clip: noop, rect: noop, beginPath: noop, drawImage: noop, setLineDash: noop, measureText: (s) => ({ width: String(s).length * 10 }), createLinearGradient: () => grad, createRadialGradient: () => grad };
    return ctx;
  }
  if (typeof root.Path2D === 'undefined') {
    root.Path2D = class { constructor() {} moveTo() {} lineTo() {} rect() {} roundRect() {} ellipse() {} closePath() {} addPath() {} };
  }

  root.TSVG = { VERSION, parse, parseXML, compile, renderFrame, sayLines, audioPlan, assetPath, defaults, combos, validate, EASE, value, makeEnv };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TSVG;
})(typeof window !== 'undefined' ? window : globalThis);
