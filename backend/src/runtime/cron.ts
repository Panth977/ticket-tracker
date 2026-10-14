/**
 * The schedule strings of SCHEDULES (runtime/functions.ts), understood the
 * way Cloud Scheduler understands them, so the VM's in-process scheduler
 * fires at the same minutes as the Firebase deploy.
 *
 *   'every N minutes' / 'every N hours'   App Engine cron syntax (UTC)
 *   'm h dom mon dow'                     unix cron: *, N, a-b, a,b, * /N, a-b/N
 *
 * Evaluated in UTC, minute by minute.
 */

export interface Schedule {
  /** Does the schedule fire at this minute (any ms inside it)? */
  matches(at: Date): boolean;
}

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step: ${part}`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range!.includes('-')) {
      [lo, hi] = range!.split('-').map(Number) as [number, number];
    } else {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      throw new Error(`Bad cron field: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseSchedule(spec: string): Schedule {
  const every = /^every (\d+) (minutes?|hours?)$/i.exec(spec.trim());
  if (every) {
    const n = Number(every[1]);
    const minutes = every[2]!.toLowerCase().startsWith('hour') ? n * 60 : n;
    if (!n) throw new Error(`Bad schedule: ${spec}`);
    // App Engine 'every N minutes' runs on a fixed grid from the start of the day (UTC).
    return { matches: (at) => (at.getUTCHours() * 60 + at.getUTCMinutes()) % minutes === 0 };
  }
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Bad cron: ${spec}`);
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const M = field(mi, 0, 59);
  const H = field(h, 0, 23);
  const D = field(dom, 1, 31);
  const MO = field(mon, 1, 12);
  const W = field(dow.replace(/\b7\b/g, '0'), 0, 6);
  const domAny = dom === '*';
  const dowAny = dow === '*';
  return {
    matches(at) {
      if (!M.has(at.getUTCMinutes()) || !H.has(at.getUTCHours()) || !MO.has(at.getUTCMonth() + 1))
        return false;
      // Unix rule: when both day fields are restricted, either may match.
      const d = D.has(at.getUTCDate());
      const w = W.has(at.getUTCDay());
      if (domAny && dowAny) return true;
      if (domAny) return w;
      if (dowAny) return d;
      return d || w;
    },
  };
}
