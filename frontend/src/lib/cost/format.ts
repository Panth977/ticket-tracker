/**
 * WHAT A TURN COSTS, WRITTEN DOWN (docs/plan/agents.html §Y). One place for the
 * money and the minutes, so the receipt row, the drawer chip, the card chip,
 * the board bar, the Boards tile and the Analytics page all spell a number the
 * same way.
 *
 *   fmtUsd(1.2345)   → '$1.23'     two decimals under $10
 *   fmtUsd(12.34)    → '$12.3'     one decimal under $100
 *   fmtUsd(402.27)   → '$402'      whole dollars from $100, thousands-comma'd
 *   fmtUsdExact(n)   → '$402.27'   always cents — where the number is READ,
 *                                  not glanced at (drawer header, receipts, tables)
 */
import type { RunOutcome } from '@tm/shared';
import type { Tone } from '$lib/ui/types';

/** Compact: the shape of the amount, for chips and axes. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 100) return `$${n.toFixed(1)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Exact: cents always, for the places a person reads the number. */
export function fmtUsdExact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * '42 s' under a minute, '12 min' under an hour, '1 h 12 min' under a day,
 * '2 d 3 h' after that. Never seconds once there are minutes: a turn's length
 * is read at a glance.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

/** '46 calls' — API turns inside one run. */
export function fmtCalls(n: number | null | undefined): string | null {
  if (n == null) return null;
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'call' : 'calls'}`;
}

/** '9 turns' / '1 turn'. */
export function fmtTurns(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'turn' : 'turns'}`;
}

/** 'claude-fable-5-1' → 'fable-5-1': the vendor prefix says nothing on a receipt. */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, '');
}

/**
 * How an outcome should feel. review = the work is ready (good); waiting = a
 * question is open (attention); blocked / failed / timeout = it did not get
 * there (bad); stopped = someone chose to stop it (nothing to feel).
 */
export function outcomeTone(outcome: RunOutcome): Tone {
  switch (outcome) {
    case 'review':
      return 'success';
    case 'waiting':
      return 'warning';
    case 'blocked':
    case 'failed':
    case 'timeout':
      return 'danger';
    case 'stopped':
    default:
      return 'neutral';
  }
}

/** The text class for an outcome word, from the same tones as Badge. */
export function outcomeClass(outcome: RunOutcome): string {
  switch (outcomeTone(outcome)) {
    case 'success':
      return 'text-success';
    case 'warning':
      return 'text-warning';
    case 'danger':
      return 'text-danger';
    default:
      return 'text-muted';
  }
}

/** Tokens, compact: '1.2M in · 48k out · 980k cached'. */
export function fmtUsage(
  u: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined,
): string | null {
  if (!u) return null;
  const k = (n: number) =>
    n < 1_000
      ? String(n)
      : n < 1_000_000
        ? `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
        : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${k(u.input)} in · ${k(u.output)} out · ${k(u.cacheRead + u.cacheWrite)} cached`;
}
