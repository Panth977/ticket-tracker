/**
 * Evaluates a parsed ruleset (parse.ts) for one request — what the Firestore
 * and Storage servers do with firestore.rules / storage.rules on Firebase.
 *
 *   const rs = parseRules(readFileSync('firestore.rules', 'utf8'));
 *   await allowed(rs, { path: '/databases/(default)/documents/users/u1',
 *                       method: 'get', request, resource, lookup });
 *
 * Semantics kept from Firebase:
 *   - a request is allowed when ANY matching `allow` for its method holds
 *     (read = get + list, write = create + update + delete)
 *   - a match applies when its whole (nested) pattern consumes the whole path;
 *     {x} takes one segment, {x=**} the rest (zero or more)
 *   - an error (a missing field, a type mismatch …) makes that condition
 *     false — except that `||` / `&&` still decide when the other side can:
 *     `error || true` is true, `error && false` is false
 *   - get()/exists() read the database through `lookup` (the VM's db port)
 */
import type { Allow, Expr, FunctionDecl, Match, Ruleset, Seg } from './parse.js';

export class RuleError extends Error {}

/** A path value (/databases/(default)/documents/users/u1). */
export class RulePath {
  constructor(readonly segs: string[]) {}
  toString(): string {
    return '/' + this.segs.join('/');
  }
}
/** A set value (map.keys().toSet(), diff().affectedKeys() …). */
export class RuleSet {
  readonly items: unknown[];
  constructor(items: unknown[]) {
    this.items = [];
    for (const i of items) if (!this.items.some((x) => eq(x, i))) this.items.push(i);
  }
}

export interface Resource {
  [k: string]: unknown;
}
export interface RulesRequest {
  auth: { uid: string; token: Record<string, unknown> } | null;
  method: string;
  path: string;
  time: unknown;
  resource?: Resource | null;
  [k: string]: unknown;
}
export interface Lookup {
  /** A document as rules see it ({ data, id, __name__ }), or null when missing. */
  get(path: string[]): Promise<Resource | null>;
}
export interface Evaluation {
  /** The full request path, e.g. '/databases/(default)/documents/users/u1' or '/b/default/o/users/u1/a.png'. */
  path: string;
  /** get | list | create | update | delete */
  method: string;
  request: RulesRequest;
  resource: Resource | null;
  lookup: Lookup;
  /** Storage rules call firestore.get()/exists() — the Firestore lookup. */
  firestore?: Lookup;
}

const METHOD_GROUPS: Record<string, string[]> = {
  read: ['get', 'list'],
  write: ['create', 'update', 'delete'],
};
const covers = (allowName: string, method: string) =>
  allowName === method || (METHOD_GROUPS[allowName] ?? []).includes(method);

// ─── values ──────────────────────────────────────────────────────────────────

const isMap = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  !(v instanceof RulePath) &&
  !(v instanceof RuleSet) &&
  !isTimestamp(v) &&
  !(v instanceof Uint8Array);
const isTimestamp = (v: unknown): v is { toMillis(): number } =>
  !!v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function';
const listOf = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (v instanceof RuleSet) return v.items;
  throw new RuleError('Not a list or set');
};

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (isTimestamp(a) && isTimestamp(b)) return a.toMillis() === b.toMillis();
  if (a instanceof RulePath && b instanceof RulePath) return a.toString() === b.toString();
  if (a instanceof RuleSet && b instanceof RuleSet)
    return a.items.length === b.items.length && a.items.every((x) => b.items.some((y) => eq(x, y)));
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]));
  }
  return false;
}

function typeIs(v: unknown, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'int':
      return typeof v === 'number' && Number.isInteger(v);
    case 'float':
      return typeof v === 'number' && !Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'bool':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'list':
      return Array.isArray(v);
    case 'set':
      return v instanceof RuleSet;
    case 'map':
      return isMap(v);
    case 'timestamp':
      return isTimestamp(v);
    case 'path':
      return v instanceof RulePath;
    case 'bytes':
      return v instanceof Uint8Array;
    default:
      throw new RuleError(`Unknown type ${t}`);
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (isTimestamp(a) && isTimestamp(b)) return a.toMillis() - b.toMillis();
  throw new RuleError('Values are not comparable');
}

const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new RuleError('Condition is not a boolean');
  return v;
};

/** A RE2 pattern as the rules mean it: the WHOLE string must match. */
const regex = (re: string) => new RegExp(`^(?:${re})$`, 'u');

// ─── methods on values ───────────────────────────────────────────────────────

function method(target: unknown, name: string, args: unknown[]): unknown {
  if (typeof target === 'string') {
    switch (name) {
      case 'size':
        return [...target].length;
      case 'matches':
        return regex(String(args[0])).test(target);
      case 'lower':
        return target.toLowerCase();
      case 'upper':
        return target.toUpperCase();
      case 'trim':
        return target.trim();
      case 'split':
        return target.split(new RegExp(String(args[0]), 'u'));
      case 'replace':
        return target.replace(new RegExp(String(args[0]), 'gu'), String(args[1]));
    }
  }
  if (Array.isArray(target) || target instanceof RuleSet) {
    const items = listOf(target);
    const other = () => listOf(args[0]);
    switch (name) {
      case 'size':
        return items.length;
      case 'hasAll':
        return other().every((x) => items.some((y) => eq(x, y)));
      case 'hasAny':
        return other().some((x) => items.some((y) => eq(x, y)));
      case 'hasOnly':
        return items.every((x) => other().some((y) => eq(x, y)));
      case 'toSet':
        return new RuleSet(items);
      case 'concat':
        return [...items, ...other()];
      case 'removeAll':
        return items.filter((x) => !other().some((y) => eq(x, y)));
      case 'join':
        return items.map(String).join(String(args[0] ?? ''));
      case 'union':
        return new RuleSet([...items, ...other()]);
      case 'difference':
        return new RuleSet(items.filter((x) => !other().some((y) => eq(x, y))));
      case 'intersection':
        return new RuleSet(items.filter((x) => other().some((y) => eq(x, y))));
    }
  }
  if (isMap(target)) {
    switch (name) {
      case 'get': {
        const keys = Array.isArray(args[0]) ? (args[0] as unknown[]) : [args[0]];
        let cur: unknown = target;
        for (const k of keys) {
          if (!isMap(cur) || cur[String(k)] === undefined) return args[1];
          cur = cur[String(k)];
        }
        return cur;
      }
      case 'keys':
        return Object.keys(target).filter((k) => target[k] !== undefined);
      case 'values':
        return Object.keys(target)
          .filter((k) => target[k] !== undefined)
          .map((k) => target[k]);
      case 'size':
        return Object.keys(target).filter((k) => target[k] !== undefined).length;
      case 'diff': {
        const o = args[0];
        if (!isMap(o)) throw new RuleError('diff() needs a map');
        const has = (m: Record<string, unknown>, k: string) => m[k] !== undefined;
        const all = new Set([...Object.keys(target), ...Object.keys(o)]);
        const added: string[] = [];
        const removed: string[] = [];
        const changed: string[] = [];
        const unchanged: string[] = [];
        for (const k of all) {
          const a = has(target, k);
          const b = has(o, k);
          if (a && !b) added.push(k);
          else if (!a && b) removed.push(k);
          else if (a && b) (eq(target[k], o[k]) ? unchanged : changed).push(k);
        }
        return {
          __diff: true,
          added,
          removed,
          changed,
          unchanged,
        };
      }
    }
    if ((target as { __diff?: boolean }).__diff) {
      const d = target as unknown as Record<
        'added' | 'removed' | 'changed' | 'unchanged',
        string[]
      >;
      switch (name) {
        case 'addedKeys':
          return new RuleSet(d.added);
        case 'removedKeys':
          return new RuleSet(d.removed);
        case 'changedKeys':
          return new RuleSet(d.changed);
        case 'unchangedKeys':
          return new RuleSet(d.unchanged);
        case 'affectedKeys':
          return new RuleSet([...d.added, ...d.removed, ...d.changed]);
      }
    }
  }
  if (isTimestamp(target)) {
    const ms = target.toMillis();
    const d = new Date(ms);
    switch (name) {
      case 'toMillis':
        return ms;
      case 'seconds':
        return Math.floor(ms / 1000);
      case 'year':
        return d.getUTCFullYear();
      case 'month':
        return d.getUTCMonth() + 1;
      case 'day':
        return d.getUTCDate();
    }
  }
  if (target instanceof RulePath && name === 'bind') return target;
  throw new RuleError(`No method ${name}() on this value`);
}

// ─── evaluation ──────────────────────────────────────────────────────────────

interface Scope {
  vars: Map<string, unknown>;
  fns: Map<string, FunctionDecl>;
  parent?: Scope;
}
const lookupVar = (s: Scope | undefined, n: string): { found: boolean; v?: unknown } => {
  for (let c = s; c; c = c.parent) if (c.vars.has(n)) return { found: true, v: c.vars.get(n) };
  return { found: false };
};
const lookupFn = (s: Scope | undefined, n: string): FunctionDecl | undefined => {
  for (let c = s; c; c = c.parent) if (c.fns.has(n)) return c.fns.get(n);
  return undefined;
};

class Evaluator {
  private depth = 0;
  private reads = new Map<string, Promise<Resource | null>>();

  constructor(private readonly ev: Evaluation) {}

  private async getDoc(path: unknown, service: 'self' | 'firestore'): Promise<Resource | null> {
    if (!(path instanceof RulePath)) throw new RuleError('get() needs a path');
    const lookup = service === 'firestore' ? this.ev.firestore : this.ev.lookup;
    if (!lookup) throw new RuleError('No database to read from');
    const key = `${service}:${path}`;
    let p = this.reads.get(key);
    if (!p) {
      p = lookup.get(path.segs);
      this.reads.set(key, p);
    }
    return p;
  }

  async expr(e: Expr, s: Scope): Promise<unknown> {
    switch (e.t) {
      case 'lit':
        return e.v;
      case 'id': {
        const v = lookupVar(s, e.name);
        if (v.found) return v.v;
        if (e.name === 'request') return this.ev.request;
        if (e.name === 'resource') return this.ev.resource;
        if (
          e.name === 'math' ||
          e.name === 'firestore' ||
          e.name === 'timestamp' ||
          e.name === 'duration'
        )
          return { __ns: e.name };
        throw new RuleError(`Unknown variable ${e.name}`);
      }
      case 'list':
        return Promise.all(e.items.map((i) => this.expr(i, s)));
      case 'map': {
        const out: Record<string, unknown> = {};
        for (const [k, v] of e.entries) out[k] = await this.expr(v, s);
        return out;
      }
      case 'path': {
        const segs: string[] = [];
        for (const p of e.parts) {
          if (typeof p === 'string') segs.push(p);
          else {
            const v = await this.expr(p, s);
            if (v instanceof RulePath) segs.push(...v.segs);
            else if (typeof v === 'string' || typeof v === 'number') segs.push(String(v));
            else throw new RuleError('A path segment must be a string');
          }
        }
        return new RulePath(segs);
      }
      case 'un': {
        const v = await this.expr(e.e, s);
        if (e.op === '!') return !bool(v);
        if (typeof v !== 'number') throw new RuleError('Unary minus on a non-number');
        return -v;
      }
      case 'cond':
        return bool(await this.expr(e.c, s)) ? this.expr(e.a, s) : this.expr(e.b, s);
      case 'is':
        return typeIs(await this.expr(e.e, s), e.type);
      case 'bin':
        return this.binary(e, s);
      case 'member': {
        const o = await this.expr(e.e, s);
        if (isMap(o)) {
          if ((o as { __ns?: string }).__ns)
            return { __nsfn: `${(o as { __ns: string }).__ns}.${e.name}` };
          if (o[e.name] === undefined) {
            // A method referenced for a call (map.get, keys …) resolves at the call.
            return { __method: e.name, __on: o };
          }
          return o[e.name];
        }
        if (o === null || o === undefined) throw new RuleError(`Property ${e.name} on null`);
        return { __method: e.name, __on: o };
      }
      case 'index': {
        const o = await this.expr(e.e, s);
        const i = await this.expr(e.i, s);
        if (Array.isArray(o) && typeof i === 'number') {
          if (i < 0 || i >= o.length) throw new RuleError('Index out of range');
          return o[i];
        }
        if (isMap(o) && typeof i === 'string') {
          if (o[i] === undefined) throw new RuleError(`No key ${i}`);
          return o[i];
        }
        if (o instanceof RulePath && typeof i === 'number') return o.segs[i];
        throw new RuleError('Bad index');
      }
      case 'call':
        return this.call(e, s);
    }
  }

  private async binary(e: Extract<Expr, { t: 'bin' }>, s: Scope): Promise<unknown> {
    if (e.op === '||' || e.op === '&&') {
      const decides = e.op === '||';
      let left: boolean | Error;
      try {
        left = bool(await this.expr(e.l, s));
      } catch (err) {
        left = err as Error;
      }
      if (left === decides) return decides;
      let right: boolean | Error;
      try {
        right = bool(await this.expr(e.r, s));
      } catch (err) {
        right = err as Error;
      }
      if (right === decides) return decides;
      if (left instanceof Error) throw left;
      if (right instanceof Error) throw right;
      return !decides;
    }
    const l = await this.expr(e.l, s);
    const r = await this.expr(e.r, s);
    switch (e.op) {
      case '==':
        return eq(l, r);
      case '!=':
        return !eq(l, r);
      case '<':
        return compare(l, r) < 0;
      case '<=':
        return compare(l, r) <= 0;
      case '>':
        return compare(l, r) > 0;
      case '>=':
        return compare(l, r) >= 0;
      case 'in':
        if (Array.isArray(r) || r instanceof RuleSet) return listOf(r).some((x) => eq(x, l));
        if (isMap(r)) return typeof l === 'string' && r[l] !== undefined;
        throw new RuleError("'in' needs a list, set or map");
      case '+':
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'string' && typeof r === 'string') return l + r;
        if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
        throw new RuleError('Bad operands for +');
      case '-':
      case '*':
      case '/':
      case '%':
        if (typeof l !== 'number' || typeof r !== 'number')
          throw new RuleError(`Bad operands for ${e.op}`);
        if ((e.op === '/' || e.op === '%') && r === 0) throw new RuleError('Division by zero');
        if (e.op === '-') return l - r;
        if (e.op === '*') return l * r;
        if (e.op === '%') return l % r;
        return Number.isInteger(l) && Number.isInteger(r) ? Math.trunc(l / r) : l / r;
    }
    throw new RuleError(`Unknown operator ${e.op}`);
  }

  private async call(e: Extract<Expr, { t: 'call' }>, s: Scope): Promise<unknown> {
    const args = () => Promise.all(e.args.map((a) => this.expr(a, s)));
    if (e.fn.t === 'id') {
      const name = e.fn.name;
      const fn = lookupFn(s, name);
      if (fn) {
        if (++this.depth > 20) throw new RuleError('Function call depth exceeded');
        try {
          const vals = await args();
          const local: Scope = {
            vars: new Map(fn.params.map((p, i) => [p, vals[i]])),
            fns: new Map(),
            parent: s,
          };
          for (const [n, x] of fn.lets) local.vars.set(n, await this.expr(x, local));
          return await this.expr(fn.body, local);
        } finally {
          this.depth--;
        }
      }
      const vals = await args();
      switch (name) {
        case 'get':
        case 'getAfter':
          // A missing document is null (reading a field of it is then an error).
          return this.getDoc(vals[0], 'self');
        case 'exists':
        case 'existsAfter':
          return (await this.getDoc(vals[0], 'self')) !== null;
        case 'string':
          return vals[0] === null ? 'null' : String(vals[0]);
        case 'int':
          return Math.trunc(Number(vals[0]));
        case 'float':
          return Number(vals[0]);
        case 'path':
          return new RulePath(String(vals[0]).split('/').filter(Boolean));
        case 'debug':
          return vals[0];
      }
      throw new RuleError(`Unknown function ${name}()`);
    }
    const target = await this.expr(e.fn, s);
    const vals = await args();
    if (isMap(target) && typeof (target as { __nsfn?: string }).__nsfn === 'string') {
      const ns = (target as { __nsfn: string }).__nsfn;
      switch (ns) {
        case 'firestore.get':
          return this.getDoc(vals[0], 'firestore');
        case 'firestore.exists':
          return (await this.getDoc(vals[0], 'firestore')) !== null;
        case 'math.abs':
          return Math.abs(Number(vals[0]));
        case 'math.floor':
          return Math.floor(Number(vals[0]));
        case 'math.ceil':
          return Math.ceil(Number(vals[0]));
        case 'math.round':
          return Math.round(Number(vals[0]));
        case 'math.min':
          return Math.min(...vals.map(Number));
        case 'math.max':
          return Math.max(...vals.map(Number));
      }
      throw new RuleError(`Unknown function ${ns}()`);
    }
    if (isMap(target) && typeof (target as { __method?: string }).__method === 'string') {
      const m = target as { __method: string; __on: unknown };
      return method(m.__on, m.__method, vals);
    }
    throw new RuleError('Not callable');
  }

  /** Does any allow in the matched blocks admit this request? */
  async allowed(rs: Ruleset): Promise<boolean> {
    const segs = this.ev.path.split('/').filter(Boolean);
    const found: { allow: Allow; scope: Scope }[] = [];
    const walk = (m: Match, i: number, parent: Scope | undefined) => {
      for (const { end, vars } of consume(m.path, segs, i)) {
        const scope: Scope = { vars, fns: new Map(m.functions.map((f) => [f.name, f])), parent };
        if (end === segs.length)
          for (const a of m.allows)
            if (a.methods.some((x) => covers(x, this.ev.method))) found.push({ allow: a, scope });
        for (const child of m.matches) walk(child, end, scope);
      }
    };
    walk(rs.root, 0, undefined);
    for (const { allow, scope } of found) {
      if (!allow.cond) return true;
      try {
        if (bool(await this.expr(allow.cond, scope))) return true;
      } catch {
        // An error is a "no" for this allow; another may still say yes.
      }
    }
    return false;
  }
}

/** Every way a match pattern can consume segments from position i. */
function* consume(
  pattern: Seg[],
  segs: string[],
  i: number,
): Generator<{ end: number; vars: Map<string, unknown> }> {
  const go = function* (
    pi: number,
    si: number,
    vars: Map<string, unknown>,
  ): Generator<{ end: number; vars: Map<string, unknown> }> {
    if (pi === pattern.length) {
      yield { end: si, vars };
      return;
    }
    const p = pattern[pi]!;
    if ('lit' in p) {
      if (segs[si] === p.lit) yield* go(pi + 1, si + 1, vars);
      return;
    }
    if (p.rest) {
      // {x=**}: zero or more segments — every split, so a pattern may go on after it.
      for (let k = si; k <= segs.length; k++) {
        const v = new Map(vars);
        v.set(p.v, new RulePath(segs.slice(si, k)));
        yield* go(pi + 1, k, v);
      }
      return;
    }
    if (si < segs.length) {
      const v = new Map(vars);
      v.set(p.v, segs[si]);
      yield* go(pi + 1, si + 1, v);
    }
  };
  yield* go(0, i, new Map());
}

export function allowed(rs: Ruleset, ev: Evaluation): Promise<boolean> {
  return new Evaluator(ev).allowed(rs);
}
