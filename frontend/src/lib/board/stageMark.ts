/**
 * indicators.html — a stage's mark for every picker, chip and column: its
 * indicator (legacy `color` read through indicatorOf, seeded by the stage id)
 * and the TINT colour that stands for it where only a colour fits (a bar, a
 * chip background). One helper so every stage list draws the same mark.
 */
import { indicatorColor, indicatorOf, type Indicator } from '@tm/shared';

export interface StageLike {
  id: string;
  color?: string | null;
  indicator?: Indicator | null;
  description?: string | null;
}

export interface StageMark {
  indicator: Indicator;
  /** '#rrggbb' */
  color: string;
  /** The stage's description, for a tooltip; null when it has none. */
  hint: string | null;
}

export function stageMark(s: StageLike): StageMark {
  const indicator = indicatorOf(s, s.id);
  return { indicator, color: indicatorColor(indicator), hint: s.description?.trim() || null };
}

/**
 * A board's stages as picker rows (ChoicePicker's ChoiceItem): by position,
 * each with its name, mark, tint and description.
 */
export function stageChoices(
  stages: readonly (StageLike & { name: string; position: number })[],
): { id: string; label: string; color: string; indicator: Indicator; hint: string | null }[] {
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ id: s.id, label: s.name, ...stageMark(s) }));
}
