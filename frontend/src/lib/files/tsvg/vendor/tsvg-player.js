// @ts-nocheck
// Vendored VERBATIM from the TSVG reference web engine, version 0.1
// (TSVG repository, web/tsvg-player.js @ 991e4f6). Do not edit here: update
// the source and copy it again. Shipped as text (?raw) into the sandboxed
// player frame (../frame.ts); never imported as a module by the app.

// TSVG web player: the reference engine for browsers.
// The .tsvg document carries no HTML/JS; this file is the engine that plays it:
// canvas renderer, real video controls (timeline, chapters, ±10 s, speed,
// scrub thumbnails, zoom), viewer options (language, audio mix, theme,
// layout, captions) and a WebAudio mixer with voice / music / sfx buses.
(function (root) {
  'use strict';
  const TSVG = root.TSVG;
  const fmtT = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };

  const CSS = `
  .tsvgp{position:relative;background:#000;color:#fff;font:14px system-ui,sans-serif;user-select:none;overflow:hidden;border-radius:12px}
  .tsvgp canvas.main{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
  .tsvgp .bar{position:absolute;left:0;right:0;bottom:0;padding:24px 14px 10px;background:linear-gradient(transparent,#000c);transition:opacity .25s}
  .tsvgp.idle .bar{opacity:0}
  .tsvgp .track{position:relative;height:18px;cursor:pointer}
  .tsvgp .rail{position:absolute;left:0;right:0;top:7px;height:4px;background:#ffffff38;border-radius:2px}
  .tsvgp .fill{position:absolute;left:0;top:7px;height:4px;background:#ff4d5a;border-radius:2px}
  .tsvgp .knob{position:absolute;top:3px;width:12px;height:12px;margin-left:-6px;background:#ff4d5a;border-radius:50%}
  .tsvgp .tick{position:absolute;top:5px;width:2px;height:8px;background:#000a}
  .tsvgp .tip{position:absolute;bottom:26px;transform:translateX(-50%);display:none;text-align:center;pointer-events:none}
  .tsvgp .tip canvas{display:block;border:2px solid #fff;border-radius:6px;background:#000}
  .tsvgp .tip span{display:inline-block;margin-top:4px;padding:1px 6px;background:#000c;border-radius:4px;font-size:12px}
  .tsvgp .row{display:flex;align-items:center;gap:6px;margin-top:4px}
  .tsvgp button{background:none;border:0;color:#fff;font:inherit;padding:6px 8px;border-radius:6px;cursor:pointer;min-width:34px}
  .tsvgp button:hover{background:#ffffff22}
  .tsvgp .time{font-variant-numeric:tabular-nums;opacity:.9;margin:0 6px}
  .tsvgp .chap{opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tsvgp .grow{flex:1}
  .tsvgp .menu{position:absolute;right:12px;bottom:64px;background:#16181ef2;border-radius:10px;padding:8px;min-width:230px;display:none;max-height:70%;overflow:auto;box-shadow:0 8px 30px #0008}
  .tsvgp .menu.open{display:block}
  .tsvgp .menu h4{margin:8px 8px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.6}
  .tsvgp .menu .opts{display:flex;flex-wrap:wrap;gap:4px;padding:0 6px}
  .tsvgp .menu .opts button{background:#ffffff14;font-size:13px}
  .tsvgp .menu .opts button.on{background:#ff4d5a}
  .tsvgp .cc{position:absolute;left:50%;bottom:72px;transform:translateX(-50%);width:max-content;max-width:72%;text-align:center;pointer-events:none;font-size:var(--ccs,16px)}
  .tsvgp .cc span{background:#000c;padding:2px 8px;border-radius:4px;line-height:1.55;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  .tsvgp .flash{position:absolute;top:50%;transform:translateY(-50%);padding:14px 18px;background:#0008;border-radius:40px;font-size:18px;opacity:0;transition:opacity .4s;pointer-events:none}
  .tsvgp .zoomtag{position:absolute;top:10px;left:10px;background:#000a;padding:3px 8px;border-radius:6px;font-size:12px;display:none}
  .tsvgp .big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  .tsvgp .big div{width:84px;height:84px;border-radius:50%;background:#0009;display:flex;align-items:center;justify-content:center;font-size:34px}
  .tsvgp.playing .big,.tsvgp.zoomed .big{display:none}`;

  class Player {
    // files: { path → URL } (e.g. blob URLs from a .tsvgz); base: URL the relative paths resolve against
    constructor(host, { files = {}, base, onOptions, autoplay = false } = {}) {
      if (!document.getElementById('tsvgp-css')) { const st = document.createElement('style'); st.id = 'tsvgp-css'; st.textContent = CSS; document.head.appendChild(st); }
      this.host = host; this.files = files; this.base = base || (typeof location !== 'undefined' ? location.href : ''); this.onOptions = onOptions;
      this.t = 0; this.rate = 1; this.playing = false; this.cc = true; this.layoutPref = 'auto';
      this.zoom = 1; this.panX = 0; this.panY = 0; this.images = {}; this.buffers = {}; this.loadedFonts = new Set(); this.lines = [];
      this.el = document.createElement('div'); this.el.className = 'tsvgp'; this.el.tabIndex = 0;
      this.el.innerHTML = `<canvas class="main"></canvas><div class="zoomtag"></div><div class="big"><div>▶</div></div><div class="cc"></div>
        <div class="flash" style="left:12%">⟲ 10s</div><div class="flash" style="right:12%">10s ⟳</div>
        <div class="menu"></div>
        <div class="bar"><div class="track"><div class="rail"></div><div class="fill"></div><div class="ticks"></div><div class="knob"></div><div class="tip"><canvas></canvas><span></span></div></div>
        <div class="row"><button data-a="play" title="Play (k / space)">▶</button><button data-a="back" title="Back 10s (j / ←)">⟲10</button><button data-a="fwd" title="Forward 10s (l / →)">10⟳</button>
        <span class="time"></span><span class="chap grow"></span>
        <button data-a="cc" title="Captions (c)">CC</button><button data-a="rate" title="Speed">1×</button><button data-a="menu" title="Options">⚙</button><button data-a="fs" title="Fullscreen (f)">⛶</button></div></div>`;
      host.appendChild(this.el);
      this.q = (s) => this.el.querySelector(s);
      this.canvas = this.q('canvas.main'); this.ctx = this.canvas.getContext('2d');
      this.wire();
      new ResizeObserver(() => this.draw()).observe(this.el);
    }

    url(path) { return this.files[path] || new URL(path, this.base).href; }
    async load(xml) {
      const doc = TSVG.parse(xml);
      this.doc = doc; this.opts = Object.assign(TSVG.defaults(doc), this.keepOpts(doc));
      for (const [id, a] of Object.entries(doc.assets)) {
        if (a.type !== 'image') continue;
        if (!this.images[a.src]) { const im = new Image(); im.onload = () => this.draw(); im.src = this.url(a.src); this.images[a.src] = im; }
        this.images[id] = this.images[a.src];
      }
      this.syncLines();
      await Promise.race([this.loadFonts(), new Promise((r) => setTimeout(r, 3000))]);
      this.t = Math.min(this.t, doc.duration);
      this.buildMenu(); this.buildTicks(); this.syncLines(); this.draw();
      return doc;
    }
    // .tsvgz bytes (or a URL to .tsvg / .tsvgz)
    async loadPackage(bytes) {
      const files = await root.TSVGZip.read(bytes);
      for (const u of Object.values(this.files)) if (String(u).startsWith('blob:')) URL.revokeObjectURL(u);
      this.files = {}; this.images = {}; this.buffers = {}; this.loadedFonts = new Set();
      for (const [path, data] of files) if (path !== root.TSVGZip.MAIN) this.files[path] = URL.createObjectURL(new Blob([data], { type: mimeOf(path) }));
      return this.load(root.TSVGZip.text(files.get(root.TSVGZip.MAIN)));
    }
    async open(url) {
      const r = await fetch(url); if (!r.ok) throw new Error('fetch ' + url + ': ' + r.status);
      const b = new Uint8Array(await r.arrayBuffer());
      if (root.TSVGZip && root.TSVGZip.isZip(b)) return this.loadPackage(b);
      this.base = new URL(url, this.base).href; return this.load(new TextDecoder().decode(b));
    }
    async loadFonts() {
      if (typeof FontFace === 'undefined') return;
      await Promise.all(this.doc.fonts.map(async (f) => {
        const key = f.family + '|' + f.weight + '|' + f.style + '|' + f.src; if (this.loadedFonts.has(key)) return;
        try { const ff = new FontFace(f.family, 'url(' + JSON.stringify(this.url(f.src)) + ')', { weight: f.weight, style: f.style }); await ff.load(); document.fonts.add(ff); this.loadedFonts.add(key); }
        catch (e) { console.warn('font', f.family, e); }
      }));
    }
    keepOpts(doc) { const o = {}; if (this.opts) for (const op of doc.options) if (this.opts[op.id] && op.choices.some((c) => c.id === this.opts[op.id])) o[op.id] = this.opts[op.id]; return o; }

    // ── audio ──
    async ensureAudio() {
      if (!this.ac) {
        this.ac = new (root.AudioContext || root.webkitAudioContext)();
        this.master = this.ac.createGain(); this.master.connect(this.ac.destination);
        this.buses = {}; for (const b of ['voice', 'music', 'sfx']) { const g = this.ac.createGain(); g.connect(this.master); this.buses[b] = g; }
      }
      if (this.ac.state === 'suspended') await this.ac.resume();
      const plan = TSVG.audioPlan(this.doc, this.opts);
      const paths = [...new Set(plan.clips.map((c) => TSVG.assetPath(this.doc, c.src)))].filter((p) => p && !this.buffers[p]);
      await Promise.all(paths.map(async (p) => {
        try { const r = await fetch(this.url(p)); this.buffers[p] = await this.ac.decodeAudioData(await r.arrayBuffer()); } catch (e) { console.warn('audio', p, e); }
      }));
      this.applyMix(); this.syncLines();
    }
    applyMix() {
      if (!this.buses) return;
      const mix = this.doc.mixes[this.opts.mix] || { voice: 1, music: 1, sfx: 1 };
      for (const b in this.buses) this.buses[b].gain.setTargetAtTime(mix[b] == null ? 1 : mix[b], this.ac.currentTime, 0.05);
    }
    clips() {
      return TSVG.audioPlan(this.doc, this.opts).clips.map((c) => Object.assign({}, c, { buf: this.buffers[TSVG.assetPath(this.doc, c.src)] }));
    }
    startAudio() {
      this.stopAudio(); if (!this.ac || this.rate !== 1) return; // pitch-correct speed change is out of scope for v0.1
      const now = this.ac.currentTime; this.sources = [];
      for (const c of this.clips()) {
        if (!c.buf) continue;
        const off = this.t - c.start; if (!c.loop && off >= c.buf.duration) continue;
        const s = this.ac.createBufferSource(); s.buffer = c.buf; s.loop = !!c.loop;
        const g = this.ac.createGain(); g.gain.value = c.vol; s.connect(g); g.connect(this.buses[c.bus] || this.master);
        if (off >= 0) s.start(now, c.loop ? off % c.buf.duration : off); else s.start(now - off);
        this.sources.push(s);
      }
    }
    stopAudio() { for (const s of this.sources || []) try { s.stop(); } catch (e) {} this.sources = []; if (root.speechSynthesis) speechSynthesis.cancel(); }
    // spoken lines without a baked clip use on-device TTS when a voice exists for the language
    ttsCross(prev, now) {
      if (!root.speechSynthesis || this.rate !== 1) return;
      const mix = this.doc.mixes[this.opts.mix]; if (mix && mix.voice === 0) return;
      for (const l of this.lines) if (!l.clip && prev < l.start && l.start <= now) {
        const v = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(l.lang)); if (!v) continue;
        const u = new SpeechSynthesisUtterance(l.text); u.voice = v; u.lang = v.lang; speechSynthesis.speak(u);
      }
    }

    // ── transport ──
    async play() { if (this.t >= this.doc.duration - 0.05) this.t = 0; this.playing = true; this.el.classList.add('playing'); await this.ensureAudio(); this.clock = performance.now(); this.startAudio(); this.loop(); this.ui(); }
    pause() { this.playing = false; this.el.classList.remove('playing'); this.stopAudio(); this.ui(); }
    toggle() { this.playing ? this.pause() : this.play(); }
    seek(t) { this.t = Math.min(this.doc.duration, Math.max(0, t)); if (this.playing) { this.clock = performance.now(); this.startAudio(); } this.draw(); }
    loop() {
      if (!this.playing) return;
      const now = performance.now(); const prev = this.t;
      this.t += ((now - this.clock) / 1000) * this.rate; this.clock = now;
      this.ttsCross(prev, this.t);
      if (this.t >= this.doc.duration) { this.t = this.doc.duration; this.draw(); return this.pause(); }
      this.draw(); requestAnimationFrame(() => this.loop());
    }

    layout() {
      const L = this.doc.layouts; const want = this.layoutPref;
      if (want !== 'auto') return L.find((l) => l.id === want) || L[0];
      const r = this.el.clientWidth / Math.max(1, this.el.clientHeight);
      return L.slice().sort((a, b) => Math.abs(Math.log(a.w / a.h / r)) - Math.abs(Math.log(b.w / b.h / r)))[0];
    }
    syncLines() { this.lines = TSVG.sayLines(this.doc, this.opts); for (const l of this.lines) { const b = l.clip && this.buffers[TSVG.assetPath(this.doc, l.clip)]; if (b) l.dur = b.duration + 0.3; } }

    draw() {
      if (!this.doc) return;
      const dpr = root.devicePixelRatio || 1; const W = this.el.clientWidth, H = this.el.clientHeight;
      if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
      const L = this.layout(); const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      const s = Math.min(W / L.w, H / L.h) * dpr * this.zoom;
      const ox = (W * dpr - L.w * s) / 2 + this.panX * dpr, oy = (H * dpr - L.h * s) / 2 + this.panY * dpr;
      ctx.setTransform(s, 0, 0, s, ox, oy);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.w, L.h); ctx.clip();
      try { TSVG.renderFrame(ctx, this.doc, this.t, this.opts, L, this.images); this.err = null; } catch (e) { this.err = e; console.error(e); }
      ctx.restore();
      if (this.err) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#ff4d5a'; ctx.font = '14px monospace'; ctx.fillText('render error: ' + this.err.message, 12, 24); }
      this.el.style.setProperty('--ccs', Math.max(12, Math.min(20, W * 0.022)) + 'px');
      this.el.classList.toggle('zoomed', this.zoom > 1.01);
      this.ui();
    }
    thumb(t) {
      const c = this.q('.tip canvas'); const L = this.layout(); const w = L.w > L.h ? 176 : 90; const h = Math.round((w * L.h) / L.w);
      c.width = w * 2; c.height = h * 2; c.style.width = w + 'px'; c.style.height = h + 'px';
      const ctx = c.getContext('2d'); ctx.setTransform((w * 2) / L.w, 0, 0, (w * 2) / L.w, 0, 0);
      try { TSVG.renderFrame(ctx, this.doc, t, this.opts, L, this.images); } catch (e) {}
    }

    ui() {
      if (!this.doc) return;
      const d = this.doc.duration, k = d ? this.t / d : 0;
      this.q('.fill').style.width = k * 100 + '%'; this.q('.knob').style.left = k * 100 + '%';
      this.q('.time').textContent = fmtT(this.t) + ' / ' + fmtT(d);
      this.q('[data-a=play]').textContent = this.playing ? '❚❚' : '▶';
      this.q('[data-a=rate]').textContent = this.rate + '×';
      this.q('[data-a=cc]').style.opacity = this.cc ? 1 : 0.45;
      const ch = this.doc.chapters.filter((c) => c.t <= this.t + 1e-6).pop();
      this.q('.chap').textContent = ch ? '• ' + this.str(ch.label) : '';
      const line = this.cc && this.lines.find((l) => this.t >= l.start && this.t < l.start + l.dur);
      this.q('.cc').innerHTML = line ? '<span></span>' : ''; if (line) this.q('.cc span').textContent = line.text;
      const zt = this.q('.zoomtag'); zt.style.display = this.zoom > 1.01 ? 'block' : 'none'; zt.textContent = 'zoom ' + this.zoom.toFixed(1) + '× · still sharp · double-click to reset';
    }
    str(v) { return v && v[0] === '@' ? TSVG.value(v, TSVG.makeEnv(this.doc, this.opts, this.doc.layouts[0], 0), this.doc) : v; }

    buildTicks() { this.q('.ticks').innerHTML = this.doc.chapters.filter((c) => c.t > 0).map((c) => `<div class="tick" style="left:${(c.t / this.doc.duration) * 100}%"></div>`).join(''); }
    buildMenu() {
      const m = this.q('.menu'); const groups = [];
      for (const o of this.doc.options) groups.push({ id: o.id, label: o.label, choices: o.choices, cur: this.opts[o.id] });
      groups.push({ id: '__layout', label: 'Layout (player)', choices: [{ id: 'auto', label: 'Auto (fit screen)' }].concat(this.doc.layouts.map((l) => ({ id: l.id, label: l.id + ' ' + l.w + '×' + l.h }))), cur: this.layoutPref });
      groups.push({ id: '__rate', label: 'Speed (player)', choices: [0.5, 1, 1.5, 2].map((r) => ({ id: String(r), label: r + '×' })), cur: String(this.rate) });
      m.innerHTML = groups.map((g) => `<h4>${g.label}</h4><div class="opts">${g.choices.map((c) => `<button data-g="${g.id}" data-c="${c.id}" class="${c.id === g.cur ? 'on' : ''}">${c.label}</button>`).join('')}</div>`).join('');
      m.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this.setOption(b.dataset.g, b.dataset.c); }));
    }
    setOption(g, c) {
      if (g === '__layout') { this.layoutPref = c; this.zoom = 1; this.panX = this.panY = 0; }
      else if (g === '__rate') { this.rate = +c; if (this.playing) this.startAudio(); }
      else { this.opts[g] = c; this.syncLines(); if (g === 'mix') this.applyMix(); if (this.playing) this.ensureAudio().then(() => this.playing && this.startAudio()); }
      if (this.onOptions) this.onOptions(this.opts);
      this.buildMenu(); this.draw();
    }
    // zoom keeping the point (mx, my) — relative to the player centre — fixed on screen
    zoomAt(z, mx = 0, my = 0) {
      z = Math.min(12, Math.max(1, z)); const k = z / this.zoom;
      this.panX = mx - (mx - this.panX) * k; this.panY = my - (my - this.panY) * k; this.zoom = z;
      if (z === 1) this.panX = this.panY = 0; this.draw();
    }
    flash(i) { const f = this.el.querySelectorAll('.flash')[i]; f.style.opacity = 1; clearTimeout(f._t); f._t = setTimeout(() => (f.style.opacity = 0), 450); }

    wire() {
      const act = { play: () => this.toggle(), back: () => { this.seek(this.t - 10); this.flash(0); }, fwd: () => { this.seek(this.t + 10); this.flash(1); }, cc: () => { this.cc = !this.cc; this.ui(); }, rate: () => this.setOption('__rate', String({ 0.5: 1, 1: 1.5, 1.5: 2, 2: 0.5 }[this.rate])), menu: () => this.q('.menu').classList.toggle('open'), fs: () => (document.fullscreenElement ? document.exitFullscreen() : this.el.requestFullscreen()) };
      this.el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); act[b.dataset.a](); }));
      const track = this.q('.track'); const tip = this.q('.tip');
      const at = (e) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.doc.duration; };
      let drag = false;
      track.addEventListener('pointerdown', (e) => { drag = true; track.setPointerCapture(e.pointerId); this.seek(at(e)); });
      track.addEventListener('pointermove', (e) => {
        const t = at(e); if (drag) this.seek(t);
        const r = track.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = ((t / this.doc.duration) * r.width) + 'px';
        this.thumb(t); const ch = this.doc.chapters.filter((c) => c.t <= t).pop(); tip.querySelector('span').textContent = fmtT(t) + (ch ? ' · ' + this.str(ch.label) : '');
      });
      track.addEventListener('pointerup', () => (drag = false));
      track.addEventListener('pointerleave', () => { if (!drag) tip.style.display = 'none'; });
      // tap = play/pause, double-tap side = ±10 s (phone habit), wheel / pinch = zoom
      let lastTap = 0, pan = null; const pts = new Map(); let pinch = null;
      this.canvas.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, e); this.canvas.setPointerCapture(e.pointerId); if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: this.zoom }; } else pan = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false }; });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
        if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; this.zoom = Math.min(12, Math.max(1, (pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) / pinch.d)); this.draw(); return; }
        if (pan && this.zoom > 1) { const dx = e.clientX - pan.x, dy = e.clientY - pan.y; if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true; this.panX = pan.px + dx; this.panY = pan.py + dy; this.draw(); }
      });
      this.canvas.addEventListener('pointerup', (e) => {
        pts.delete(e.pointerId); if (pinch) { if (!pts.size) pinch = null; pan = null; return; }
        if (pan && !pan.moved) {
          const now = performance.now(); const r = this.el.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width;
          if (now - lastTap < 300 && (x < 0.3 || x > 0.7)) { clearTimeout(this._tap); x < 0.3 ? act.back() : act.fwd(); }
          else { clearTimeout(this._tap); this._tap = setTimeout(() => { this.q('.menu').classList.remove('open'); this.toggle(); }, 220); }
          lastTap = now;
        }
        pan = null;
      });
      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault(); const r = this.el.getBoundingClientRect();
        this.zoomAt(this.zoom * Math.exp(-e.deltaY / 400), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
      }, { passive: false });
      this.canvas.addEventListener('dblclick', () => { this.zoom = 1; this.panX = this.panY = 0; this.draw(); });
      this.el.addEventListener('keydown', (e) => {
        const k = { ' ': 'play', k: 'play', j: 'back', ArrowLeft: 'back', l: 'fwd', ArrowRight: 'fwd', c: 'cc', f: 'fs' }[e.key];
        if (k) { e.preventDefault(); act[k](); }
        else if (/^[0-9]$/.test(e.key)) this.seek((this.doc.duration * +e.key) / 10);
      });
      let idle; const wake = () => { this.el.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => this.playing && this.el.classList.add('idle'), 2500); };
      this.el.addEventListener('pointermove', wake); this.el.addEventListener('pointerdown', wake);
    }
  }
  function mimeOf(p) {
    const e = (p.split('.').pop() || '').toLowerCase();
    return { ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }[e] || 'application/octet-stream';
  }
  root.TSVGPlayer = Player;
})(window);
