/**
 * INDICATORS AND DESCRIPTIONS (docs/plan/indicators.html) — one way to mark
 * every entity a person names: a board, a board's stage, an artifact, a
 * memory, a workspace.
 *
 *   indicator    what the sidebar, the title dropdowns, cards and pickers draw
 *                for it. Exactly one of:
 *                  color   a solid dot in one of INDICATOR_COLORS
 *                  icon    one of INDICATOR_ICONS (lucide), tinted in a colour
 *                  emoji   one emoji, PICKED (never typed — the picker
 *                          inserts it)
 *                  image   an image the person uploaded (Storage
 *                          indicators/{uid}/{fileId}/{name}, ≤ 1 MB)
 *   description  plain text (Markdown allowed) saying what it is FOR — read
 *                mostly by agents (MCP / REST list it), shown under the name.
 *
 * Old documents carry the legacy fields (board color + typed icon, stage
 * color, artifact / memory emoji `icon`, workspace color); indicatorOf()
 * reads either, so nothing breaks before scripts/migrate-indicators.mjs runs.
 */
import { z } from 'zod';

/** Plain text, mostly for agents. Same limit everywhere. */
export const DESCRIPTION_MAX = 2000;
export const DescriptionSchema = z.string().max(DESCRIPTION_MAX).nullable();

/** The palette: a colour indicator and an icon's tint come from here. */
export const INDICATOR_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#64748b', // slate
  '#78716c', // stone
] as const;
const HexSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * The icon list (lucide names, kebab-case). The app maps each to its
 * component; nothing outside this list can be stored.
 */
export const INDICATOR_ICONS = [
  'layout-grid',
  'kanban',
  'list-todo',
  'check-square',
  'circle-dot',
  'target',
  'flag',
  'rocket',
  'zap',
  'star',
  'heart',
  'bookmark',
  'tag',
  'bell',
  'calendar',
  'clock',
  'briefcase',
  'building-2',
  'home',
  'users',
  'user',
  'graduation-cap',
  'book-open',
  'notebook-pen',
  'file-text',
  'folder',
  'archive',
  'inbox',
  'mail',
  'message-square',
  'phone',
  'camera',
  'image',
  'film',
  'music',
  'mic',
  'headphones',
  'palette',
  'brush',
  'pen-tool',
  'code',
  'terminal',
  'bug',
  'git-branch',
  'database',
  'server',
  'cloud',
  'cpu',
  'smartphone',
  'monitor',
  'globe',
  'map',
  'compass',
  'plane',
  'car',
  'bike',
  'shopping-cart',
  'credit-card',
  'wallet',
  'piggy-bank',
  'chart-line',
  'chart-pie',
  'trending-up',
  'dumbbell',
  'activity',
  'apple',
  'coffee',
  'utensils',
  'leaf',
  'sun',
  'moon',
  'flame',
  'gift',
  'trophy',
  'shield',
  'lock',
  'key',
  'wrench',
  'hammer',
  'lightbulb',
  'brain',
  'sparkles',
  'bot',
  'gamepad-2',
  'puzzle',
  'box',
  'package',
] as const;
export type IndicatorIcon = (typeof INDICATOR_ICONS)[number];
export const IndicatorIconSchema = z.enum(INDICATOR_ICONS);

/** Uploaded indicator images: small, and only these types. */
export const INDICATOR_IMAGE_MAX_BYTES = 1024 * 1024;
export const INDICATOR_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
] as const;
/** indicators/{uid}/{fileId}/{name} */
export const INDICATOR_PATH_RE =
  /^indicators\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{6,64}\/[^/]{1,200}$/;

export const IndicatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), color: HexSchema }).strict(),
  z.object({ kind: z.literal('icon'), icon: IndicatorIconSchema, color: HexSchema }).strict(),
  z
    .object({
      kind: z.literal('emoji'),
      // One emoji (a grapheme may be several code points: 👩🏽‍💻). Picked, not typed.
      emoji: z
        .string()
        .min(1)
        .max(32)
        .refine((s) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s), {
          message: 'Pick an emoji',
        }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      path: z.string().regex(INDICATOR_PATH_RE, 'Upload the image first'),
    })
    .strict(),
]);
export type Indicator = z.infer<typeof IndicatorSchema>;

/** A colour for a new entity, picked from the palette by a stable hash of `seed`. */
export function defaultIndicator(seed: string): Indicator {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { kind: 'color', color: INDICATOR_COLORS[h % INDICATOR_COLORS.length]! };
}

const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/** Legacy colour NAMES (boards, stages, workspaces stored 'blue', 'slate'…) → the palette. */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  rose: '#ec4899',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#22c55e',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#06b6d4',
  blue: '#3b82f6',
  slate: '#64748b',
  gray: '#64748b',
  grey: '#64748b',
  zinc: '#64748b',
  neutral: '#78716c',
  stone: '#78716c',
  brown: '#78716c',
};
/** A legacy colour (hex or a name) as hex, or null. */
export function legacyColor(c: unknown): string | null {
  if (isHex(c)) return c.toLowerCase();
  if (typeof c === 'string') return NAMED_COLORS[c.trim().toLowerCase()] ?? null;
  return null;
}
const isEmoji = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.length <= 32 &&
  /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
const isIcon = (s: unknown): s is IndicatorIcon =>
  typeof s === 'string' && (INDICATOR_ICONS as readonly string[]).includes(s);

/**
 * The indicator to DRAW for an entity: its own, else one read from the legacy
 * fields (a board's / stage's / workspace's `color` and typed `icon`, an
 * artifact's / memory's emoji `icon`), else a palette colour from `seed`.
 */
export function indicatorOf(
  e: { indicator?: Indicator | null; color?: string | null; icon?: string | null },
  seed = '',
  /** What to draw when nothing is set (default: a palette colour from `seed`). */
  fallback?: Indicator,
): Indicator {
  if (e.indicator) return e.indicator;
  const color = legacyColor(e.color);
  if (isEmoji(e.icon)) return { kind: 'emoji', emoji: e.icon };
  if (isIcon(e.icon)) return { kind: 'icon', icon: e.icon, color: color ?? INDICATOR_COLORS[0] };
  if (color) return { kind: 'color', color };
  return fallback ?? defaultIndicator(seed);
}

/** A memory nobody gave a mark draws 🧠 (as it always did): pass as indicatorOf's fallback. */
export const MEMORY_DEFAULT_INDICATOR: Indicator = { kind: 'emoji', emoji: '🧠' };

/** The tint an indicator stands for (a stage column, a key chip): its colour, or the palette's first. */
export function indicatorColor(i: Indicator): string {
  return i.kind === 'color' || i.kind === 'icon' ? i.color : INDICATOR_COLORS[0];
}
