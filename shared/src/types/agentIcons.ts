/**
 * Agent icons (agents.html §B) — the ONE list of icons an agent profile may
 * carry instead of (or under) an uploaded picture.
 *
 *   agents/{agentId}.icon      one of these ids, or null
 *   members/{agentId}.icon     the same id, denormalised like name / avatarPath
 *
 * Rendering precedence everywhere an avatar shows: a real picture (avatarPath)
 * > icon > initials. Brand marks are drawn by the frontend
 * (lib/agents/icons/*.svelte); generic ones come from lucide. The id is the
 * contract: the backend validates against this list and never needs the art.
 */
import { z } from 'zod';

export type AgentIconKind = 'brand' | 'generic';

export interface AgentIconDef {
  id: string;
  label: string;
  kind: AgentIconKind;
}

/** Ids are short, lowercase, [a-z0-9-] and at most this long. */
export const AGENT_ICON_ID_MAX = 40;

export const AGENT_ICONS = [
  // ── well-known AI brands ──
  { id: 'claude', label: 'Claude', kind: 'brand' },
  { id: 'gemini', label: 'Gemini', kind: 'brand' },
  { id: 'chatgpt', label: 'ChatGPT', kind: 'brand' },
  { id: 'copilot', label: 'Copilot', kind: 'brand' },
  { id: 'mistral', label: 'Mistral', kind: 'brand' },
  { id: 'llama', label: 'Llama', kind: 'brand' },
  { id: 'cursor', label: 'Cursor', kind: 'brand' },
  // ── generic (lucide) ──
  { id: 'bot', label: 'Bot', kind: 'generic' },
  { id: 'cpu', label: 'Chip', kind: 'generic' },
  { id: 'brain', label: 'Brain', kind: 'generic' },
  { id: 'sparkles', label: 'Sparkles', kind: 'generic' },
  { id: 'wand', label: 'Wand', kind: 'generic' },
  { id: 'zap', label: 'Zap', kind: 'generic' },
  { id: 'wrench', label: 'Wrench', kind: 'generic' },
  { id: 'hammer', label: 'Hammer', kind: 'generic' },
  { id: 'terminal', label: 'Terminal', kind: 'generic' },
  { id: 'code', label: 'Code', kind: 'generic' },
  { id: 'git-branch', label: 'Branch', kind: 'generic' },
  { id: 'bug', label: 'Bug', kind: 'generic' },
  { id: 'test-tube', label: 'Test tube', kind: 'generic' },
  { id: 'microscope', label: 'Microscope', kind: 'generic' },
  { id: 'search', label: 'Search', kind: 'generic' },
  { id: 'eye', label: 'Eye', kind: 'generic' },
  { id: 'radar', label: 'Radar', kind: 'generic' },
  { id: 'shield', label: 'Shield', kind: 'generic' },
  { id: 'megaphone', label: 'Megaphone', kind: 'generic' },
  { id: 'chart', label: 'Chart', kind: 'generic' },
  { id: 'database', label: 'Database', kind: 'generic' },
  { id: 'globe', label: 'Globe', kind: 'generic' },
  { id: 'rocket', label: 'Rocket', kind: 'generic' },
  { id: 'pen', label: 'Pen', kind: 'generic' },
  { id: 'book', label: 'Book', kind: 'generic' },
  { id: 'clipboard', label: 'Checklist', kind: 'generic' },
  { id: 'lightbulb', label: 'Idea', kind: 'generic' },
  { id: 'puzzle', label: 'Puzzle', kind: 'generic' },
  { id: 'palette', label: 'Palette', kind: 'generic' },
  { id: 'compass', label: 'Compass', kind: 'generic' },
  { id: 'target', label: 'Target', kind: 'generic' },
  { id: 'ghost', label: 'Ghost', kind: 'generic' },
] as const satisfies readonly AgentIconDef[];

export type AgentIconId = (typeof AGENT_ICONS)[number]['id'];

/** Every id, in display order — a non-empty tuple so z.enum accepts it. */
export const AGENT_ICON_IDS = AGENT_ICONS.map((i) => i.id) as unknown as readonly [
  AgentIconId,
  ...AgentIconId[],
];

export const AGENT_BRAND_ICONS = AGENT_ICONS.filter((i) => i.kind === 'brand');
export const AGENT_GENERIC_ICONS = AGENT_ICONS.filter((i) => i.kind === 'generic');

const ICON_SET: ReadonlySet<string> = new Set(AGENT_ICON_IDS);

export function isAgentIconId(id: unknown): id is AgentIconId {
  return typeof id === 'string' && ICON_SET.has(id);
}

/**
 * The stored / accepted value: one of the ids above — an unknown id is
 * rejected, so a client cannot store something the UI has no art for. Every id
 * is at most AGENT_ICON_ID_MAX chars (asserted by the tests), so the enum is
 * also the length bound. `.nullable().optional()` where it is used: null =
 * no icon (initials), absent = unchanged / phase-2 docs.
 */
export const AgentIconIdSchema = z.enum(AGENT_ICON_IDS);
