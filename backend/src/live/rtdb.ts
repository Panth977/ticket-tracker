/**
 * THE REALTIME DATABASE OVER /live — what the browser gets from Firebase's
 * RTDB on the Firebase deploy (presence, typing, agent liveness, artifact
 * pages' data), served from the VM's JSON tree (rtdb/local.ts) and checked
 * by database.rules.json (rules/database.ts).
 *
 *   { id, op: 'rtdb.get', path }                    → { value }
 *   { id, op: 'rtdb.listen', lid, path }            then { lid, value } on every change
 *   { id, op: 'rtdb.unlisten', lid }
 *   { id, op: 'rtdb.set', path, value }             (null removes)
 *   { id, op: 'rtdb.update', path, values }         multi-path keys allowed
 *   { id, op: 'rtdb.remove', path }
 *   { id, op: 'rtdb.push', path, value }            → { key }
 *   { id, op: 'rtdb.onDisconnect', path, action: 'set' | 'update' | 'remove' | 'cancel', value? }
 *   { id, op: 'rtdb.time' }                         → { now } (for .info/serverTimeOffset)
 *
 * onDisconnect writes are checked when they are registered (as Firebase
 * does) and run when the socket closes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localTree, pushId, splitPath } from '../rtdb/local.js';
import { DatabaseRules, type RtdbAuth } from '../rules/database.js';

let rules: DatabaseRules | undefined;
function databaseRules(): DatabaseRules {
  if (!rules) {
    const file =
      process.env.TM_RULES_DATABASE ||
      fileURLToPath(new URL('../../database.rules.json', import.meta.url));
    rules = new DatabaseRules(readFileSync(file, 'utf8'));
  }
  return rules;
}

export class RtdbDenied extends Error {
  readonly code = 'permission-denied';
  constructor() {
    super('Permission denied');
  }
}

type Entry = [string[], unknown];

const overlaps = (a: string[], b: string[]) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

export class RtdbSession {
  private readonly listeners = new Map<string, { segs: string[]; last: string }>();
  private readonly onClose = new Map<string, Entry[]>();
  private off: (() => void) | undefined;

  constructor(
    private readonly auth: RtdbAuth | null,
    private readonly send: (m: unknown) => void,
  ) {}

  private write(entries: Entry[]): void {
    const r = databaseRules();
    const ok = localTree().writeIf(entries, (root, next) =>
      r.canWrite(
        this.auth,
        root as never,
        next as never,
        entries.map(([s]) => s),
      ),
    );
    if (!ok) throw new RtdbDenied();
  }

  get(path: string): { value: unknown } {
    const segs = splitPath(path);
    if (!databaseRules().canRead(this.auth, localTree().root as never, segs))
      throw new RtdbDenied();
    return { value: localTree().read(segs) };
  }

  listen(lid: string, path: string): void {
    const segs = splitPath(path);
    this.listeners.set(lid, { segs, last: '' });
    this.off ??= localTree().onWrite((paths) => {
      const changed = paths.map((p) => p.split('/').filter(Boolean));
      for (const [id, l] of this.listeners)
        if (changed.some((c) => overlaps(c, l.segs))) this.push(id);
    });
    this.push(lid);
  }

  private push(lid: string): void {
    const l = this.listeners.get(lid);
    if (!l) return;
    try {
      const { value } = this.get(l.segs.join('/'));
      const json = JSON.stringify(value);
      if (json === l.last) return;
      l.last = json;
      this.send({ lid, value });
    } catch {
      this.listeners.delete(lid);
      this.send({ lid, error: { code: 'permission-denied', message: 'Permission denied' } });
    }
  }

  async handle(msg: { id: string; op: string; [k: string]: unknown }): Promise<unknown> {
    const path = typeof msg.path === 'string' ? msg.path : '';
    const segs = () => splitPath(path);
    switch (msg.op) {
      case 'rtdb.get':
        return this.get(path);
      case 'rtdb.listen':
        this.listen(String(msg.lid), path);
        return null;
      case 'rtdb.unlisten':
        this.listeners.delete(String(msg.lid));
        return null;
      case 'rtdb.set':
        this.write([[segs(), msg.value ?? null]]);
        return null;
      case 'rtdb.remove':
        this.write([[segs(), null]]);
        return null;
      case 'rtdb.update': {
        const values = (msg.values ?? {}) as Record<string, unknown>;
        this.write(
          Object.entries(values).map(([k, v]) => [[...segs(), ...splitPath(k)], v] as Entry),
        );
        return null;
      }
      case 'rtdb.push': {
        const key = pushId();
        if (msg.value !== undefined) this.write([[[...segs(), key], msg.value]]);
        return { key };
      }
      case 'rtdb.onDisconnect': {
        const action = String(msg.action);
        const key = segs().join('/');
        if (action === 'cancel') {
          for (const k of [...this.onClose.keys()])
            if (k === key || k.startsWith(`${key}/`)) this.onClose.delete(k);
          return null;
        }
        const entries: Entry[] =
          action === 'update'
            ? Object.entries((msg.value ?? {}) as Record<string, unknown>).map(
                ([k, v]) => [[...segs(), ...splitPath(k)], v] as Entry,
              )
            : [[segs(), action === 'remove' ? null : (msg.value ?? null)]];
        // Firebase checks an onDisconnect write when it is registered.
        const r = databaseRules();
        const tree = localTree();
        let ok = false;
        tree.writeIf(entries, (root, next) => {
          ok = r.canWrite(
            this.auth,
            root as never,
            next as never,
            entries.map(([s]) => s),
          );
          return false; // only a dry run
        });
        if (!ok) throw new RtdbDenied();
        this.onClose.set(key, entries);
        return null;
      }
      case 'rtdb.time':
        return { now: Date.now() };
    }
    throw new Error(`Unknown op ${msg.op}`);
  }

  /** The socket closed: run the onDisconnect writes, stop listening. */
  close(): void {
    this.listeners.clear();
    this.off?.();
    this.off = undefined;
    for (const entries of this.onClose.values()) {
      try {
        localTree().write(entries);
      } catch (e) {
        console.error('[live] onDisconnect write failed', e);
      }
    }
    this.onClose.clear();
  }
}
