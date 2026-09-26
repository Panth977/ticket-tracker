/**
 * Key validators. The regexes themselves are contracts (types/primitives.ts);
 * these are the helpers both sides use around them.
 */
import { BOARD_KEY_RE, TICKET_KEY_RE, type TicketKey } from '../types/index.js';

export { BOARD_KEY_RE, TICKET_KEY_RE };

export const isBoardKey = (s: string): boolean => BOARD_KEY_RE.test(s);
export const isTicketKey = (s: string): s is TicketKey => TICKET_KEY_RE.test(s);

/** What a person types in 'New board › Key': trimmed, upper-cased, non-alphanumerics dropped. */
export function normalizeBoardKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A key suggestion from a board name: 'Growth Marketing' → 'GM', 'Engineering' → 'ENG'. */
export function suggestBoardKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const initials = words
    .map((w) => w[0])
    .join('')
    .replace(/^[0-9]+/, '')
    .slice(0, 6);
  if (words.length > 1 && isBoardKey(initials)) return initials;
  const head = words
    .join('')
    .replace(/^[0-9]+/, '')
    .slice(0, 3);
  return isBoardKey(head) ? head : 'BRD';
}

/** 'ENG-42' (any case, optional leading '#') → { boardKey: 'ENG', number: 42 }; null if not a key. */
export function parseTicketKey(
  input: string,
): { boardKey: string; number: number; key: TicketKey } | null {
  const s = input.trim().replace(/^#/, '').toUpperCase();
  if (!TICKET_KEY_RE.test(s)) return null;
  const i = s.lastIndexOf('-');
  return { boardKey: s.slice(0, i), number: Number(s.slice(i + 1)), key: s as TicketKey };
}

export const ticketKey = (boardKey: string, n: number): TicketKey =>
  `${boardKey}-${n}` as TicketKey;

/** Every '#ENG-42' in free text, de-duplicated, in order of appearance. */
export function findTicketKeys(text: string): TicketKey[] {
  const out: TicketKey[] = [];
  for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_#])#([A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]*)\b/g)) {
    const k = m[1]!.toUpperCase() as TicketKey;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
