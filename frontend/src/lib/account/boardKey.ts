/**
 * Board keys ('ENG') on /new-board: suggested from the name, normalised as
 * typed, and checked live against boardKeys/{key} (any signed-in person may
 * GET a claim; nobody may LIST them). The server's boardCreate transaction is
 * still the authority — a 409 there means someone took it in between.
 */
import { doc, getDoc } from 'firebase/firestore';
import { BOARD_KEY_RE, paths } from '@tm/shared';
import { getDb } from '$lib/firebase/client';

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', '&', 'to', 'my', 'our']);

/**
 * 'Engineering' → 'ENG', 'Home repairs' → 'HR', 'Panth & co' → 'PC',
 * 'Q3 launch' → 'QL'. Always matches BOARD_KEY_RE when the name has any
 * letter; '' otherwise.
 */
export function suggestKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  // A key must start with a letter.
  while (words.length && !/^[A-Za-z]/.test(words[0]!)) words.shift();
  if (!words.length) return '';
  let key: string;
  if (words.length === 1) key = words[0]!.slice(0, 3);
  else
    key = words
      .map((w) => w[0])
      .join('')
      .slice(0, 4);
  key = key.toUpperCase();
  if (key.length < 2) key = (words[0]! + 'X').slice(0, 2).toUpperCase();
  return BOARD_KEY_RE.test(key) ? key : '';
}

/** What the key input keeps as you type: A–Z/0–9, upper-cased, at most 6. */
export function normalizeKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Human reason a key is not acceptable, or null when its shape is fine. */
export function keyShapeError(key: string): string | null {
  if (!key) return 'Pick a short key, like ENG.';
  if (!/^[A-Z]/.test(key)) return 'Start with a letter.';
  if (key.length < 2) return 'At least 2 characters.';
  if (!BOARD_KEY_RE.test(key)) return '2–6 characters: a letter, then letters or digits.';
  return null;
}

export type KeyStatus = 'idle' | 'invalid' | 'checking' | 'free' | 'taken' | 'unknown';

/** Is boardKeys/{key} unclaimed? A deleted board's key stays claimed (tombstone). */
export async function isKeyFree(key: string): Promise<boolean> {
  const snap = await getDoc(doc(getDb(), paths.boardKey(key)));
  return !snap.exists();
}

/**
 * Debounced live checker: call `check(key)`; `onStatus` gets 'checking' then
 * 'free' | 'taken' | 'unknown' for the LATEST key only (stale answers dropped).
 */
export function createKeyChecker(
  onStatus: (key: string, status: KeyStatus) => void,
  lookup: (key: string) => Promise<boolean> = isKeyFree,
  delayMs = 300,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = '';
  return {
    check(key: string) {
      latest = key;
      clearTimeout(timer);
      if (keyShapeError(key)) {
        onStatus(key, key ? 'invalid' : 'idle');
        return;
      }
      onStatus(key, 'checking');
      timer = setTimeout(async () => {
        let status: KeyStatus;
        try {
          status = (await lookup(key)) ? 'free' : 'taken';
        } catch {
          status = 'unknown';
        }
        if (key === latest) onStatus(key, status);
      }, delayMs);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
