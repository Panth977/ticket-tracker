/**
 * database.rules.json, evaluated the way the Realtime Database does — so a
 * VM's JSON tree (rtdb/local.ts) answers browsers exactly like Firebase.
 *
 *   .read / .write   cascade: granted at a node, granted for everything below
 *                    it (a deeper rule cannot take it back). Nothing granted on
 *                    the way down = denied. Rules are not filters: reading a
 *                    node needs a grant at or above it.
 *   .validate        every non-null node a write changes (and its ancestors)
 *                    must pass every .validate on its way; deletes skip them
 *   $vars            a `$name` child matches any key and binds it
 *   variables        auth, root, data, newData, now, $vars; snapshots with
 *                    child() val() exists() hasChild() hasChildren() isString()
 *                    isNumber() isBoolean() numChildren() parent(); strings
 *                    with length, contains(), beginsWith(), endsWith(),
 *                    matches(), toLowerCase(), toUpperCase(); === !== and the
 *                    usual operators. An error makes the rule false.
 */
import type { Expr } from './parse.js';
import { parseExpr } from './parse.js';

type Json = null | boolean | number | string | { [k: string]: Json };
type RuleNode = { [k: string]: RuleNode | string | boolean };

export interface RtdbAuth {
  uid: string;
  token: Record<string, unknown>;
}

class RtdbRuleError extends Error {}

const exprCache = new Map<string, Expr>();
function compile(src: string): Expr {
  let e = exprCache.get(src);
  if (!e) {
    // The expression language is JavaScript's; === and !== mean == and != here.
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        out += c;
        if (c === '\\') out += src[++i] ?? '';
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
        out += c;
      } else if ((c === '=' || c === '!') && src.slice(i + 1, i + 3) === '==') {
        out += c + '=';
        i += 2;
      } else out += c;
    }
    e = parseExpr(out);
    exprCache.set(src, e);
  }
  return e;
}

const childOf = (v: Json, key: string): Json =>
  v !== null && typeof v === 'object' ? ((v as Record<string, Json>)[key] ?? null) : null;
const at = (v: Json, segs: string[]): Json => segs.reduce<Json>((cur, s) => childOf(cur, s), v);

/** A rules snapshot: a value plus where it sits (for parent()). */
class Snap {
  constructor(
    readonly root: Json,
    readonly segs: string[],
  ) {}
  get value(): Json {
    return at(this.root, this.segs);
  }
  method(name: string, args: unknown[]): unknown {
    const v = this.value;
    switch (name) {
      case 'val':
        return v;
      case 'exists':
        return v !== null;
      case 'child':
        return new Snap(this.root, [...this.segs, ...String(args[0]).split('/').filter(Boolean)]);
      case 'parent':
        return new Snap(this.root, this.segs.slice(0, -1));
      case 'hasChild':
        return childOf(v, String(args[0])) !== null;
      case 'hasChildren':
        if (args.length === 0)
          return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
        return (args[0] as unknown[]).every((k) => at(v, String(k).split('/')) !== null);
      case 'numChildren':
        return v !== null && typeof v === 'object' ? Object.keys(v).length : 0;
      case 'isString':
        return typeof v === 'string';
      case 'isNumber':
        return typeof v === 'number';
      case 'isBoolean':
        return typeof v === 'boolean';
      case 'getPriority':
        return null;
    }
    throw new RtdbRuleError(`No method ${name}() on a snapshot`);
  }
}

function strMethod(s: string, name: string, args: unknown[]): unknown {
  switch (name) {
    case 'contains':
      return s.includes(String(args[0]));
    case 'beginsWith':
      return s.startsWith(String(args[0]));
    case 'endsWith':
      return s.endsWith(String(args[0]));
    case 'toLowerCase':
      return s.toLowerCase();
    case 'toUpperCase':
      return s.toUpperCase();
    case 'replace':
      return s.split(String(args[0])).join(String(args[1]));
    case 'matches': {
      const re = args[0];
      return re instanceof RegExp ? re.test(s) : new RegExp(String(re)).test(s);
    }
  }
  throw new RtdbRuleError(`No method ${name}() on a string`);
}

interface Ctx {
  vars: Record<string, unknown>;
}

function evalExpr(e: Expr, ctx: Ctx): unknown {
  switch (e.t) {
    case 'lit':
      return e.v;
    case 'id':
      if (e.name in ctx.vars) return ctx.vars[e.name];
      throw new RtdbRuleError(`Unknown variable ${e.name}`);
    case 'list':
      return e.items.map((i) => evalExpr(i, ctx));
    case 'un': {
      const v = evalExpr(e.e, ctx);
      return e.op === '!' ? !v : -(v as number);
    }
    case 'cond':
      return evalExpr(e.c, ctx) === true ? evalExpr(e.a, ctx) : evalExpr(e.b, ctx);
    case 'bin': {
      if (e.op === '&&') return evalExpr(e.l, ctx) === true && evalExpr(e.r, ctx) === true;
      if (e.op === '||') return evalExpr(e.l, ctx) === true || evalExpr(e.r, ctx) === true;
      const l = evalExpr(e.l, ctx) as never;
      const r = evalExpr(e.r, ctx) as never;
      switch (e.op) {
        case '==':
          return l === r;
        case '!=':
          return l !== r;
        case '<':
          return l < r;
        case '<=':
          return l <= r;
        case '>':
          return l > r;
        case '>=':
          return l >= r;
        case '+':
          return (l as number) + (r as number);
        case '-':
          return (l as number) - (r as number);
        case '*':
          return (l as number) * (r as number);
        case '/':
          return (l as number) / (r as number);
        case '%':
          return (l as number) % (r as number);
      }
      throw new RtdbRuleError(`Operator ${e.op}`);
    }
    case 'member': {
      const o = evalExpr(e.e, ctx);
      if (typeof o === 'string' && e.name === 'length') return o.length;
      if (o instanceof Snap || typeof o === 'string') return { __m: e.name, __on: o };
      if (o !== null && typeof o === 'object' && !Array.isArray(o)) {
        const v = (o as Record<string, unknown>)[e.name];
        if (v === undefined) throw new RtdbRuleError(`No property ${e.name}`);
        return v;
      }
      throw new RtdbRuleError(`Property ${e.name} of ${o === null ? 'null' : typeof o}`);
    }
    case 'call': {
      const target = evalExpr(e.fn, ctx) as { __m?: string; __on?: unknown };
      const args = e.args.map((a) => evalExpr(a, ctx));
      if (target && typeof target.__m === 'string') {
        if (target.__on instanceof Snap) return target.__on.method(target.__m, args);
        if (typeof target.__on === 'string') return strMethod(target.__on, target.__m, args);
      }
      throw new RtdbRuleError('Not callable');
    }
    default:
      throw new RtdbRuleError(`Unsupported expression (${e.t})`);
  }
}

function truthy(rule: string | boolean | undefined, ctx: Ctx): boolean {
  if (rule === undefined) return false;
  if (typeof rule === 'boolean') return rule;
  try {
    return evalExpr(compile(rule), ctx) === true;
  } catch {
    return false;
  }
}

/** The rule nodes along a path, with the $vars bound on the way. */
function walk(rules: RuleNode, segs: string[]): { node: RuleNode; vars: Record<string, string> }[] {
  const out: { node: RuleNode; vars: Record<string, string> }[] = [{ node: rules, vars: {} }];
  let node: RuleNode = rules;
  let vars: Record<string, string> = {};
  for (const s of segs) {
    const lit: RuleNode | string | boolean | undefined = node[s];
    if (lit && typeof lit === 'object') node = lit;
    else {
      // No rule this deep: the path goes on, but nothing below grants or validates.
      const wild = Object.keys(node).find((k) => k.startsWith('$'));
      if (!wild) break;
      vars = { ...vars, [wild]: s };
      node = node[wild] as RuleNode;
    }
    out.push({ node, vars });
  }
  return out;
}

export class DatabaseRules {
  private readonly rules: RuleNode;
  constructor(json: string | object) {
    const parsed = (typeof json === 'string' ? JSON.parse(json) : json) as { rules: RuleNode };
    this.rules = parsed.rules;
  }

  private ctx(
    auth: RtdbAuth | null,
    root: Json,
    newRoot: Json,
    segs: string[],
    vars: Record<string, string>,
  ): Ctx {
    return {
      vars: {
        auth,
        now: Date.now(),
        root: new Snap(root, []),
        data: new Snap(root, segs),
        newData: new Snap(newRoot, segs),
        ...vars,
      },
    };
  }

  canRead(auth: RtdbAuth | null, root: Json, segs: string[]): boolean {
    const steps = walk(this.rules, segs);
    return steps.some((s, i) =>
      truthy(
        s.node['.read'] as string | boolean | undefined,
        this.ctx(auth, root, root, segs.slice(0, i), s.vars),
      ),
    );
  }

  /**
   * May these writes (each a path and its new value; null deletes) turn `root`
   * into `newRoot`? Every written location needs a .write grant on its way;
   * every changed non-null node passes its .validate rules.
   */
  canWrite(auth: RtdbAuth | null, root: Json, newRoot: Json, written: string[][]): boolean {
    for (const segs of written) {
      const steps = walk(this.rules, segs);
      const ok = steps.some((s, i) =>
        truthy(
          s.node['.write'] as string | boolean | undefined,
          this.ctx(auth, root, newRoot, segs.slice(0, i), s.vars),
        ),
      );
      if (!ok) return false;
    }
    // .validate: ancestors of every written location, then the written subtrees.
    const checked = new Set<string>();
    const validateAt = (segs: string[]): boolean => {
      const key = segs.join('/');
      if (checked.has(key)) return true;
      checked.add(key);
      if (at(newRoot, segs) === null) return true;
      const steps = walk(this.rules, segs);
      if (steps.length < segs.length + 1) return true; // no rule node this deep
      const s = steps[steps.length - 1]!;
      const rule = s.node['.validate'];
      return (
        rule === undefined ||
        truthy(rule as string | boolean, this.ctx(auth, root, newRoot, segs, s.vars))
      );
    };
    const subtree = (segs: string[]): boolean => {
      if (!validateAt(segs)) return false;
      const v = at(newRoot, segs);
      if (v !== null && typeof v === 'object')
        for (const k of Object.keys(v)) if (!subtree([...segs, k])) return false;
      return true;
    };
    for (const segs of written) {
      for (let i = 0; i < segs.length; i++) if (!validateAt(segs.slice(0, i))) return false;
      if (!subtree(segs)) return false;
    }
    return true;
  }
}
