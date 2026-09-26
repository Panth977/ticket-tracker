/**
 * The art behind an agent's `icon` id (shared types/agentIcons): brand marks
 * drawn here (one small inline SVG each, currentColor) and generic glyphs from
 * lucide. The id list itself lives in @tm/shared — the backend validates it,
 * this file only says what each id looks like.
 *
 *   agentIcon('claude')   → a component taking { size }; null for an unknown id
 */
import type { Component } from 'svelte';
import {
  Book,
  Bot,
  Brain,
  Bug,
  ChartBar,
  ClipboardCheck,
  Code,
  Compass,
  Cpu,
  Database,
  Eye,
  Ghost,
  GitBranch,
  Globe,
  Hammer,
  Lightbulb,
  Megaphone,
  Microscope,
  Palette,
  PenLine,
  Puzzle,
  Radar,
  Rocket,
  Search,
  Shield,
  Sparkles,
  Target,
  Terminal,
  TestTube,
  WandSparkles,
  Wrench,
  Zap,
} from 'lucide-svelte';
import { AGENT_ICONS, isAgentIconId, type AgentIconId } from '@tm/shared';
import ChatGPT from './ChatGPT.svelte';
import Claude from './Claude.svelte';
import Copilot from './Copilot.svelte';
import Cursor from './Cursor.svelte';
import Gemini from './Gemini.svelte';
import Llama from './Llama.svelte';
import Mistral from './Mistral.svelte';

export type AgentIconComponent = Component<{ size?: number; class?: string }>;

const g = (c: unknown) => c as AgentIconComponent;

const BRAND: Partial<Record<AgentIconId, AgentIconComponent>> = {
  claude: Claude,
  gemini: Gemini,
  chatgpt: ChatGPT,
  copilot: Copilot,
  mistral: Mistral,
  llama: Llama,
  cursor: Cursor,
};

/**
 * Built on first use, not at import: the lucide bindings are only read when an
 * icon is actually drawn (named imports stay tree-shakeable; screens without
 * an agent icon — and tests that stub lucide-svelte with a short list — never
 * touch them).
 */
const generic = (): Partial<Record<AgentIconId, AgentIconComponent>> => ({
  bot: g(Bot),
  cpu: g(Cpu),
  brain: g(Brain),
  sparkles: g(Sparkles),
  wand: g(WandSparkles),
  zap: g(Zap),
  wrench: g(Wrench),
  hammer: g(Hammer),
  terminal: g(Terminal),
  code: g(Code),
  'git-branch': g(GitBranch),
  bug: g(Bug),
  'test-tube': g(TestTube),
  microscope: g(Microscope),
  search: g(Search),
  eye: g(Eye),
  radar: g(Radar),
  shield: g(Shield),
  megaphone: g(Megaphone),
  chart: g(ChartBar),
  database: g(Database),
  globe: g(Globe),
  rocket: g(Rocket),
  pen: g(PenLine),
  book: g(Book),
  clipboard: g(ClipboardCheck),
  lightbulb: g(Lightbulb),
  puzzle: g(Puzzle),
  palette: g(Palette),
  compass: g(Compass),
  target: g(Target),
  ghost: g(Ghost),
});
let GENERIC: Partial<Record<AgentIconId, AgentIconComponent>> | null = null;

/** The component for an icon id, or null when the id is unknown (or empty). */
export function agentIcon(id: string | null | undefined): AgentIconComponent | null {
  if (!isAgentIconId(id)) return null;
  return BRAND[id] ?? (GENERIC ??= generic())[id] ?? null;
}

/** The label shown in the picker / tooltips for an icon id ('' when unknown). */
export function agentIconLabel(id: string | null | undefined): string {
  return AGENT_ICONS.find((i) => i.id === id)?.label ?? '';
}
