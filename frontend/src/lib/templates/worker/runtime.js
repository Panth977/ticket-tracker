// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- plain JS, shipped as text into the worker (host.ts); its contract is protocol.ts
// @ts-nocheck
/* global WorkerGlobalScope */
/**
 * THE TEMPLATE RUNTIME (docs/plan/templates.html §B, §C) — the code that runs
 * INSIDE a template's worker, around the board's own code.
 *
 * This file is shipped as text (`?raw`) and started as a module Worker from a
 * data: URL, so the worker's origin is OPAQUE: it has no cookies, no
 * IndexedDB, no app storage and no same-origin access to the app's API. It
 * may fetch() the open web (CORS applies) — that is the template's business.
 * What it can reach of the app is `api`, and every `api` call is answered by
 * the page (host.ts), as the person looking, for the one board the template
 * belongs to.
 *
 * It must stay self-contained: no imports (a data: module has no base URL).
 *
 *   page → worker   load · event · submit · cards · apiResult · ping
 *   worker → page   ready · loaded · render · error · submitted · cards · api · log · pong
 *
 * `boot(scope)` is exported so the unit tests can run it against a fake scope.
 */

/** Tags `h.el` may draw, and the attributes it passes on. */
const EL_TAGS = new Set([
  'div',
  'span',
  'p',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'code',
  'pre',
  'kbd',
  'mark',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'caption',
  'label',
  'section',
  'header',
  'footer',
  'figure',
  'figcaption',
  'sup',
  'sub',
  'details',
  'summary',
]);
const MAX_NODES = 5000;
const MAX_LOG = 2000;

export function boot(scope) {
  const post = (m) => scope.postMessage(m);

  // ── line numbers: where the template's line 1 sits inside new Function ──
  const SOURCE = 'template.js';
  const lineOf = (e, offset) => {
    const s = e && typeof e.stack === 'string' ? e.stack : '';
    const m = new RegExp(`${SOURCE.replace('.', '\\.')}:(\\d+)`).exec(s);
    if (!m) return undefined;
    const n = Number(m[1]) - offset;
    return n > 0 ? n : undefined;
  };
  let LINE_OFFSET = 0;
  try {
    new Function(
      'api',
      'h',
      'console',
      `"use strict";\nthrow new Error('probe');\n//# sourceURL=${SOURCE}`,
    )();
  } catch (e) {
    const m = new RegExp(`${SOURCE.replace('.', '\\.')}:(\\d+)`).exec(String(e && e.stack));
    // The probe throws on the line after "use strict" — which is the template's line 1.
    LINE_OFFSET = m ? Number(m[1]) - 1 : 0;
  }
  const errText = (e) =>
    e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);

  // ── console → the editor's log (the template's own console; the worker's is left alone) ──
  const fmt = (args) =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, MAX_LOG);
  const logTo =
    (level) =>
    (...args) =>
      post({ type: 'log', level, text: fmt(args) });
  const tplConsole = Object.freeze({
    log: logTo('log'),
    info: logTo('log'),
    debug: logTo('log'),
    warn: logTo('warn'),
    error: logTo('error'),
  });

  // ── api: every call is a message the page answers ──
  const pending = new Map();
  let nextCall = 1;
  const call =
    (method) =>
    (...args) =>
      new Promise((resolve, reject) => {
        const id = nextCall++;
        pending.set(id, { resolve, reject });
        try {
          post({ type: 'api', id, method, args });
        } catch (e) {
          pending.delete(id);
          reject(new Error(`api.${method}: the arguments must be plain data (${errText(e)})`));
        }
      });
  const api = Object.freeze({
    board: call('board'),
    me: call('me'),
    members: call('members'),
    tickets: Object.freeze({
      get: call('tickets.get'),
      list: call('tickets.list'),
      search: call('tickets.search'),
    }),
    storage: Object.freeze({ get: call('storage.get'), set: call('storage.set') }),
  });

  // ── h: the builder ──
  // A hole (null, false, '' …) keeps its slot, so `cond && h.x()` never shifts
  // the nodes after it (the page keeps their DOM — and their focus).
  const kids = (list, out = []) => {
    for (const c of list) {
      if (c === null || c === undefined || c === false || c === true || c === '') out.push(null);
      else if (Array.isArray(c)) kids(c, out);
      else if (typeof c === 'number' || typeof c === 'bigint') out.push(String(c));
      else out.push(c);
    }
    return out;
  };
  const isProps = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && !(v && v.$tm === 1);
  const node = (t, props, children) => {
    const p = { ...(props || {}) };
    const k = p.key;
    delete p.key;
    const n = { $tm: 1, t, p, c: kids(children || []) };
    if (k !== undefined && k !== null) n.k = typeof k === 'number' ? k : String(k);
    return n;
  };
  /** (props?, ...children) */
  const container =
    (t, extra) =>
    (a, ...rest) =>
      isProps(a) ? node(t, { ...extra, ...a }, rest) : node(t, { ...extra }, [a, ...rest]);
  /** (text, props?) */
  const leaf = (t, field) => (a, b) =>
    isProps(a) ? node(t, a, []) : node(t, { ...(b || {}), [field]: a }, []);
  const h = Object.freeze({
    div: container('box', {}),
    box: container('box', {}),
    row: container('box', { dir: 'row' }),
    col: container('box', { dir: 'col' }),
    grid: container('box', { dir: 'grid' }),
    text: (a, b, ...rest) =>
      isProps(a) ? node('text', a, [b, ...rest]) : node('text', b || {}, [a]),
    heading: (a, b) =>
      isProps(a) ? node('heading', a, []) : node('heading', { ...(b || {}), text: a }, []),
    markdown: leaf('markdown', 'md'),
    badge: leaf('badge', 'text'),
    divider: (p) => node('divider', p || {}, []),
    link: (a, b) =>
      isProps(a) ? node('link', a, []) : node('link', { ...(b || {}), label: a }, []),
    image: (a) => node('image', typeof a === 'string' ? { src: a } : a || {}, []),
    person: (a, b) =>
      isProps(a) ? node('person', a, []) : node('person', { ...(b || {}), id: a }, []),
    ticket: (a, b) =>
      isProps(a) ? node('ticket', a, []) : node('ticket', { ...(b || {}), key: a }, []),
    progress: (p) => node('progress', p || {}, []),
    input: (p) => node('input', p || {}, []),
    textarea: (p) => node('textarea', p || {}, []),
    select: (p) => node('select', p || {}, []),
    checkbox: (p) => node('checkbox', p || {}, []),
    radio: (p) => node('radio', p || {}, []),
    button: (a, b) =>
      isProps(a) ? node('button', a, []) : node('button', { ...(b || {}), label: a }, []),
    el: (tag, a, ...rest) => {
      const t = String(tag || '').toLowerCase();
      if (!EL_TAGS.has(t))
        throw new Error(`h.el: <${t}> is not allowed (allowed: ${[...EL_TAGS].join(', ')})`);
      return isProps(a) ? node('el', { ...a, tag: t }, rest) : node('el', { tag: t }, [a, ...rest]);
    },
  });

  // ── serialising a render: functions become handler refs ──
  // A handler's id is WHERE it sits — the node's path (keys, else slot
  // indexes) and the prop — not which render made it. An event always runs
  // the newest function at that place, however many renders happened while it
  // was on its way (typing fast must never drop a key); an event for a place
  // that is gone is dropped.
  let table = new Map();
  const serialise = (roots, withHandlers) => {
    const next = new Map();
    let count = 0;
    const walk = (v, path) => {
      if (v === null || typeof v === 'string') return v;
      if (!v || v.$tm !== 1)
        throw new Error(
          `render must return h.* nodes, text, arrays, null or false — got ${v === null ? 'null' : typeof v}`,
        );
      if (++count > MAX_NODES) throw new Error(`A render may draw at most ${MAX_NODES} nodes`);
      const p = {};
      for (const [key, val] of Object.entries(v.p)) {
        if (typeof val === 'function') {
          if (!withHandlers) continue;
          const id = `${path}|${key}`;
          next.set(id, val);
          p[key] = { $h: id };
        } else if (val !== undefined) p[key] = val;
      }
      const out = { t: v.t, p };
      if (v.k !== undefined) out.k = v.k;
      if (v.c.some((x) => x !== null))
        out.c = v.c.map((c, i) =>
          walk(
            c,
            `${path}/${c && typeof c === 'object' && c.k !== undefined ? `k${JSON.stringify(c.k)}` : i}${c && typeof c === 'object' ? c.t : ''}`,
          ),
        );
      return out;
    };
    const list = kids(Array.isArray(roots) ? roots : [roots]);
    const tree = list.map((c, i) =>
      walk(
        c,
        `${c && typeof c === 'object' && c.k !== undefined ? `k${JSON.stringify(c.k)}` : i}${c && typeof c === 'object' ? c.t : ''}`,
      ),
    );
    if (withHandlers) table = next;
    return tree;
  };

  // ── the template ──
  let def = null;
  let kind = 'message';
  let baseCtx = {};
  let state = {};
  let loaded = false;
  let ack = 0;
  let queued = false;

  const compile = (code) => {
    const src = String(code);
    if (!/^\s*export\s+default\s/m.test(src))
      throw new Error(
        'A template needs `export default { render(state, setState, h, ctx) { … } }`',
      );
    const body = src.replace(/^(\s*)export\s+default\s+/m, '$1return ');
    const factory = new Function(
      'api',
      'h',
      'console',
      `"use strict";\n${body}\n//# sourceURL=${SOURCE}`,
    );
    let d = factory(api, h, tplConsole);
    if (typeof d === 'function') d = { render: d };
    if (!d || typeof d !== 'object' || typeof d.render !== 'function')
      throw new Error('The default export needs a render(state, setState, h, ctx) function');
    return d;
  };

  const fail = (phase, e) =>
    post({ type: 'error', phase, message: errText(e), line: lineOf(e, LINE_OFFSET) });

  const setState = (patch) => {
    try {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (next && typeof next === 'object') state = { ...state, ...next };
    } catch (e) {
      fail('setState', e);
    }
    schedule();
  };
  const render = () => {
    queued = false;
    if (!loaded) return;
    try {
      const tree = serialise(def.render(state, setState, h, baseCtx), true);
      post({ type: 'render', tree, ack });
    } catch (e) {
      fail('render', e);
      // Still tell the page the events were seen, so typing never stalls.
      post({ type: 'render', tree: null, ack });
    }
  };
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(render);
  }

  const handlers = {
    async load(m) {
      kind = m.kind;
      baseCtx = Object.freeze({ ...(m.ctx || {}), api });
      try {
        def = compile(m.code);
      } catch (e) {
        return fail('compile', e);
      }
      if ((kind === 'message' || kind === 'ticket') && typeof def.submit !== 'function')
        return fail('compile', new Error(`A ${kind} template needs a submit(state, ctx) function`));
      if (kind === 'card') {
        loaded = true;
        return post({ type: 'loaded' });
      }
      try {
        const init =
          typeof def.state === 'function'
            ? await def.state(baseCtx)
            : (def.state ?? def.initialState ?? {});
        state = init && typeof init === 'object' ? { ...init } : {};
      } catch (e) {
        return fail('state', e);
      }
      loaded = true;
      post({ type: 'loaded' });
      render();
    },
    async event(m) {
      const fn = table.get(m.h);
      ack = Math.max(ack, m.seq);
      if (fn) {
        try {
          const r = fn(...(m.args || []));
          if (r && typeof r.then === 'function') r.then(undefined, (e) => fail('event', e));
        } catch (e) {
          fail('event', e);
        }
      }
      schedule();
    },
    async submit(m) {
      if (!loaded || typeof def?.submit !== 'function')
        return post({ type: 'submitted', id: m.id, error: 'The template is not ready' });
      try {
        const result = await def.submit(state, baseCtx);
        post({ type: 'submitted', id: m.id, result: JSON.parse(JSON.stringify(result ?? null)) });
      } catch (e) {
        post({ type: 'submitted', id: m.id, error: errText(e), line: lineOf(e, LINE_OFFSET) });
      }
    },
    async cards(m) {
      const results = await Promise.all(
        (m.items || []).map(async (it) => {
          if (!loaded) return { id: it.id, error: 'The template did not load' };
          try {
            const ctx = Object.freeze({ ...baseCtx, ...(it.ctx || {}), api });
            const st =
              typeof def.state === 'function'
                ? await def.state(ctx)
                : (def.state ?? def.initialState ?? {});
            const tree = serialise(
              def.render(st || {}, () => {}, h, ctx),
              false,
            );
            return { id: it.id, tree };
          } catch (e) {
            return { id: it.id, error: errText(e), line: lineOf(e, LINE_OFFSET) };
          }
        }),
      );
      post({ type: 'cards', id: m.id, results });
    },
    async apiResult(m) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error || 'api call failed'));
    },
    async ping(m) {
      post({ type: 'pong', n: m.n });
    },
  };

  scope.onmessage = (e) => {
    const m = e.data;
    const fn = m && handlers[m.type];
    if (fn) void fn(m);
  };
  post({ type: 'ready' });
  return { api, h };
}

// In a real worker, start at once. (Under tests this module is imported, not run.)
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) boot(self);
