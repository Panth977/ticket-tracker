/**
 * indicators.html — the indicator picker's emoji: categories, parsing of the
 * generated data (./data.ts, lazy-loaded) and search by NAME / keyword. The
 * search box only filters the grid; an emoji is always PICKED, never typed.
 */
export interface EmojiItem {
  emoji: string;
  /** CLDR name, e.g. 'grinning face'. */
  name: string;
  keywords: string[];
  category: string;
}
export interface EmojiCategory {
  id: string;
  label: string;
  items: EmojiItem[];
}
export interface EmojiData {
  categories: EmojiCategory[];
  all: EmojiItem[];
}

/** The tabs, in order (also the ids in data.ts). */
export const EMOJI_CATEGORIES: readonly { id: string; label: string }[] = [
  { id: 'smileys', label: 'Smileys' },
  { id: 'people', label: 'People' },
  { id: 'nature', label: 'Nature' },
  { id: 'food', label: 'Food' },
  { id: 'travel', label: 'Travel' },
  { id: 'activities', label: 'Activities' },
  { id: 'objects', label: 'Objects' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'flags', label: 'Flags' },
];

/** Parse the compact form: [id, label, "emoji|name|kw,kw\n…"][]. */
export function parseEmojiData(raw: readonly (readonly [string, string, string])[]): EmojiData {
  const categories: EmojiCategory[] = raw.map(([id, label, lines]) => ({
    id,
    label,
    items: lines
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [emoji = '', name = '', kw = ''] = line.split('|');
        return { emoji, name, keywords: kw ? kw.split(',') : [], category: id };
      })
      .filter((e) => e.emoji && e.name),
  }));
  return { categories, all: categories.flatMap((c) => c.items) };
}

let loading: Promise<EmojiData> | null = null;
/** The data set, imported on first use and kept. */
export function loadEmojiData(): Promise<EmojiData> {
  loading ??= import('./data').then((m) => parseEmojiData(m.EMOJI_RAW));
  return loading;
}

/**
 * Emoji whose name or keywords match `query`, best first:
 *   0 the whole name, 1 the name starts with it, 2 a name word starts with it,
 *   3 a keyword starts with it, 4 the name contains it, 5 a keyword contains it.
 * Every word of a multi-word query must match somewhere. Empty → [].
 */
export function searchEmoji(items: readonly EmojiItem[], query: string, limit = 120): EmojiItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const words = q.split(' ');
  const scored: { e: EmojiItem; s: number; i: number }[] = [];
  items.forEach((e, i) => {
    const name = e.name.toLowerCase();
    const kws = e.keywords;
    const hay = `${name} ${kws.join(' ')}`;
    if (!words.every((w) => hay.includes(w))) return;
    let s: number;
    if (name === q) s = 0;
    else if (name.startsWith(q)) s = 1;
    else if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) s = 2;
    else if (kws.some((k) => k.startsWith(q))) s = 3;
    else if (name.includes(q)) s = 4;
    else s = 5;
    scored.push({ e, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.e);
}
