/**
 * The art behind an agent's `icon` id (shared types/agentIcons): brand marks
 * (the real logos, ./brands.ts, drawn by BrandMark.svelte in their own
 * colours) and generic glyphs from lucide. The id list itself lives in
 * @tm/shared — the backend validates it, this file only says what each id
 * looks like.
 *
 *   agentBrand('claude')  → the mark's art (paths, tile colours); null otherwise
 *   agentIcon('bot')      → a component taking { size }; null for a brand or
 *                           unknown id
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
import { BRAND_ART, type BrandArt } from './brands';

export type { BrandArt };
export type AgentIconComponent = Component<{ size?: number; class?: string }>;

const g = (c: unknown) => c as AgentIconComponent;

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

/** The brand art for an icon id, or null when it is not a brand mark. */
export function agentBrand(id: string | null | undefined): BrandArt | null {
  return isAgentIconId(id) ? (BRAND_ART[id] ?? null) : null;
}

/** The lucide component for a generic icon id, or null (brand, unknown, empty). */
export function agentIcon(id: string | null | undefined): AgentIconComponent | null {
  if (!isAgentIconId(id)) return null;
  return (GENERIC ??= generic())[id] ?? null;
}

/** The label shown in the picker / tooltips for an icon id ('' when unknown). */
export function agentIconLabel(id: string | null | undefined): string {
  return AGENT_ICONS.find((i) => i.id === id)?.label ?? '';
}
