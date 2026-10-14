/**
 * A parser for the Firebase security-rules language (rules_version '2') —
 * the language of backend/firestore.rules and backend/storage.rules — so a
 * VM can enforce the very same files the Firebase deploy uploads.
 *
 * It covers the part of the language those files use (and a little more):
 * service / match / function / let / allow, path patterns with {var} and
 * {var=**}, expressions with ?: || && == != < <= > >= in is + - * / % ! and
 * unary minus, member access, calls, indexing, list and map literals, and
 * path literals (/databases/$(database)/documents/users/$(uid)).
 */

export type Expr =
  | { t: 'lit'; v: unknown }
  | { t: 'id'; name: string }
  | { t: 'list'; items: Expr[] }
  | { t: 'map'; entries: [string, Expr][] }
  | { t: 'path'; parts: (string | Expr)[] }
  | { t: 'un'; op: '!' | '-'; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'is'; e: Expr; type: string }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'member'; e: Expr; name: string }
  | { t: 'index'; e: Expr; i: Expr }
  | { t: 'call'; fn: Expr; args: Expr[] };

export interface FunctionDecl {
  name: string;
  params: string[];
  lets: [string, Expr][];
  body: Expr;
}
export interface Allow {
  methods: string[];
  cond: Expr | null;
}
/** One path segment of a match pattern. */
export type Seg = { lit: string } | { v: string; rest: boolean };
export interface Match {
  path: Seg[];
  functions: FunctionDecl[];
  allows: Allow[];
  matches: Match[];
}
export interface Ruleset {
  service: string;
  root: Match;
}

export class RulesSyntaxError extends Error {}

const ID = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUM = /(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/y;

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  private fail(msg: string): never {
    const line = this.src.slice(0, this.i).split('\n').length;
    throw new RulesSyntaxError(`${msg} at line ${line}`);
  }
  /** Skip whitespace and comments. */
  ws(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) return;
      if (/\s/.test(c)) this.i++;
      else if (this.src.startsWith('//', this.i)) {
        const n = this.src.indexOf('\n', this.i);
        this.i = n < 0 ? this.src.length : n + 1;
      } else if (this.src.startsWith('/*', this.i)) {
        const n = this.src.indexOf('*/', this.i + 2);
        this.i = n < 0 ? this.src.length : n + 2;
      } else return;
    }
  }
  peek(s: string): boolean {
    this.ws();
    if (!this.src.startsWith(s, this.i)) return false;
    // A keyword must end at a word boundary.
    if (/^[A-Za-z_]/.test(s) && /[A-Za-z0-9_$]/.test(this.src[this.i + s.length] ?? ''))
      return false;
    return true;
  }
  eat(s: string): boolean {
    if (!this.peek(s)) return false;
    this.i += s.length;
    return true;
  }
  expect(s: string): void {
    if (!this.eat(s)) this.fail(`Expected '${s}'`);
  }
  ident(): string {
    this.ws();
    ID.lastIndex = this.i;
    const m = ID.exec(this.src);
    if (!m) this.fail('Expected an identifier');
    this.i += m[0].length;
    return m[0];
  }
  string(): string {
    this.ws();
    const q = this.src[this.i];
    if (q !== "'" && q !== '"') this.fail('Expected a string');
    let out = '';
    this.i++;
    for (;;) {
      const c = this.src[this.i++];
      if (c === undefined) this.fail('Unterminated string');
      if (c === q) return out;
      if (c === '\\') {
        const n = this.src[this.i++];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else out += c;
    }
  }

  // ─── structure ─────────────────────────────────────────────────────────────

  ruleset(): Ruleset {
    if (this.eat('rules_version')) {
      this.expect('=');
      this.string();
      this.eat(';');
    }
    this.expect('service');
    let service = this.ident();
    while (this.eat('.')) service += `.${this.ident()}`;
    this.expect('{');
    const root: Match = { path: [], functions: [], allows: [], matches: [] };
    this.body(root);
    this.expect('}');
    this.ws();
    if (this.i < this.src.length) this.fail('Unexpected text after the service');
    return { service, root };
  }

  body(m: Match): void {
    for (;;) {
      if (this.peek('}')) return;
      if (this.eat('match')) m.matches.push(this.match());
      else if (this.eat('function')) m.functions.push(this.func());
      else if (this.eat('allow')) m.allows.push(this.allow());
      else this.fail('Expected match, function or allow');
    }
  }

  match(): Match {
    this.ws();
    const path: Seg[] = [];
    while (this.src[this.i] === '/') {
      this.i++;
      if (this.src[this.i] === '{') {
        this.i++;
        const v = this.ident();
        const rest = this.eat('=**');
        this.expect('}');
        path.push({ v, rest });
      } else {
        const start = this.i;
        while (this.i < this.src.length && !/[\s/{]/.test(this.src[this.i]!)) this.i++;
        path.push({ lit: this.src.slice(start, this.i) });
      }
    }
    if (!path.length) this.fail('Expected a match path');
    this.expect('{');
    const m: Match = { path, functions: [], allows: [], matches: [] };
    this.body(m);
    this.expect('}');
    return m;
  }

  func(): FunctionDecl {
    const name = this.ident();
    this.expect('(');
    const params: string[] = [];
    if (!this.eat(')')) {
      do params.push(this.ident());
      while (this.eat(','));
      this.expect(')');
    }
    this.expect('{');
    const lets: [string, Expr][] = [];
    while (this.eat('let')) {
      const n = this.ident();
      this.expect('=');
      lets.push([n, this.expr()]);
      this.expect(';');
    }
    this.expect('return');
    const body = this.expr();
    this.eat(';');
    this.expect('}');
    return { name, params, lets, body };
  }

  allow(): Allow {
    const methods = [this.ident()];
    while (this.eat(',')) methods.push(this.ident());
    let cond: Expr | null = null;
    if (this.eat(':')) {
      this.expect('if');
      cond = this.expr();
    }
    this.expect(';');
    return { methods, cond };
  }

  // ─── expressions ───────────────────────────────────────────────────────────

  expr(): Expr {
    const c = this.or();
    if (this.eat('?')) {
      const a = this.expr();
      this.expect(':');
      return { t: 'cond', c, a, b: this.expr() };
    }
    return c;
  }
  or(): Expr {
    let l = this.and();
    while (this.eat('||')) l = { t: 'bin', op: '||', l, r: this.and() };
    return l;
  }
  and(): Expr {
    let l = this.rel();
    while (this.eat('&&')) l = { t: 'bin', op: '&&', l, r: this.rel() };
    return l;
  }
  rel(): Expr {
    let l = this.add();
    for (;;) {
      if (this.eat('is')) {
        l = { t: 'is', e: l, type: this.ident() };
        continue;
      }
      const op =
        ['==', '!=', '<=', '>=', '<', '>'].find((o) => this.peek(o)) ??
        (this.peek('in') ? 'in' : null);
      if (!op) return l;
      this.i += op.length;
      l = { t: 'bin', op, l, r: this.add() };
    }
  }
  add(): Expr {
    let l = this.mul();
    for (;;) {
      this.ws();
      const c = this.src[this.i];
      if ((c === '+' || c === '-') && this.src[this.i + 1] !== '=') {
        this.i++;
        l = { t: 'bin', op: c, l, r: this.mul() };
      } else return l;
    }
  }
  mul(): Expr {
    let l = this.unary();
    for (;;) {
      this.ws();
      const c = this.src[this.i];
      // After an operand '/' is division; a path literal only starts where an operand is expected.
      if (c === '*' || c === '%' || c === '/') {
        this.i++;
        l = { t: 'bin', op: c, l, r: this.unary() };
      } else return l;
    }
  }
  unary(): Expr {
    if (this.eat('!')) return { t: 'un', op: '!', e: this.unary() };
    this.ws();
    if (this.src[this.i] === '-' && !/\d/.test(this.src[this.i + 1] ?? '')) {
      this.i++;
      return { t: 'un', op: '-', e: this.unary() };
    }
    return this.postfix(this.primary());
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat('.')) e = { t: 'member', e, name: this.ident() };
      else if (this.peek('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.eat(')')) {
          do args.push(this.expr());
          while (this.eat(','));
          this.expect(')');
        }
        e = { t: 'call', fn: e, args };
      } else if (this.peek('[')) {
        this.i++;
        const i = this.expr();
        this.expect(']');
        e = { t: 'index', e, i };
      } else return e;
    }
  }
  primary(): Expr {
    this.ws();
    const c = this.src[this.i];
    if (c === '(') {
      this.i++;
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (c === '[') {
      this.i++;
      const items: Expr[] = [];
      if (!this.eat(']')) {
        do {
          if (this.peek(']')) break;
          items.push(this.expr());
        } while (this.eat(','));
        this.expect(']');
      }
      return { t: 'list', items };
    }
    if (c === '{') {
      this.i++;
      const entries: [string, Expr][] = [];
      if (!this.eat('}')) {
        do {
          this.ws();
          const k =
            this.src[this.i] === "'" || this.src[this.i] === '"' ? this.string() : this.ident();
          this.expect(':');
          entries.push([k, this.expr()]);
        } while (this.eat(','));
        this.expect('}');
      }
      return { t: 'map', entries };
    }
    if (c === "'" || c === '"') return { t: 'lit', v: this.string() };
    if (c === '/') return this.pathLiteral();
    if (
      c !== undefined &&
      /[\d.]/.test(c) &&
      /\d/.test(this.src[this.i + (c === '.' ? 1 : 0)] ?? '')
    ) {
      NUM.lastIndex = this.i;
      const m = NUM.exec(this.src)!;
      this.i += m[0].length;
      return { t: 'lit', v: Number(m[0]) };
    }
    if (c === '-' && /\d/.test(this.src[this.i + 1] ?? '')) {
      this.i++;
      const e = this.primary();
      return { t: 'un', op: '-', e };
    }
    const id = this.ident();
    if (id === 'true') return { t: 'lit', v: true };
    if (id === 'false') return { t: 'lit', v: false };
    if (id === 'null') return { t: 'lit', v: null };
    return { t: 'id', name: id };
  }
  /** /databases/$(database)/documents/users/$(request.auth.uid) */
  pathLiteral(): Expr {
    const parts: (string | Expr)[] = [];
    while (this.src[this.i] === '/') {
      this.i++;
      if (this.src.startsWith('$(', this.i)) {
        this.i += 2;
        parts.push(this.expr());
        this.expect(')');
      } else if (this.src[this.i] === '(') {
        // Storage's /databases/(default)/… — a literal segment in parentheses.
        const end = this.src.indexOf(')', this.i);
        parts.push(this.src.slice(this.i + 1, end));
        this.i = end + 1;
      } else {
        const start = this.i;
        while (this.i < this.src.length && /[A-Za-z0-9_\-.~%]/.test(this.src[this.i]!)) this.i++;
        if (this.i === start) this.fail('Expected a path segment');
        parts.push(this.src.slice(start, this.i));
      }
    }
    return { t: 'path', parts };
  }
}

export function parseRules(src: string): Ruleset {
  return new Parser(src).ruleset();
}

/** Parse a single expression (database.rules.json uses the expression language alone). */
export function parseExpr(src: string): Expr {
  const p = new Parser(src);
  const e = p.expr();
  p.ws();
  if (p.i < src.length)
    throw new RulesSyntaxError(`Unexpected text in expression: ${src.slice(p.i, p.i + 20)}`);
  return e;
}
