/**
 * indicators.html — the entity's mark on create / update, for the entities
 * whose LEGACY field is a typed emoji `icon` (artifacts, memories).
 *
 * `indicator` wins. An old client that still sends only `icon` gets an emoji
 * indicator from it. Whatever is written, `icon` is kept in step (the emoji,
 * or null) so an old client still draws something sensible.
 */
import { indicatorOf, type Indicator } from '@tm/shared';

interface MarkInput {
  indicator?: Indicator | undefined;
  icon?: string | null | undefined;
}

const iconFor = (i: Indicator): string | null => (i.kind === 'emoji' ? i.emoji : null);

/** A new entity's { indicator, icon }: from input, else `fallback`. */
export function markOnCreate(
  input: MarkInput,
  fallback: Indicator,
): { indicator: Indicator; icon: string | null } {
  let indicator = input.indicator;
  if (!indicator && input.icon) {
    const legacy = indicatorOf({ icon: input.icon }, '');
    if (legacy.kind === 'emoji') indicator = legacy;
  }
  indicator ??= fallback;
  return { indicator, icon: iconFor(indicator) };
}

/** The fields an update writes (none when neither was sent). */
export function markPatch(input: MarkInput): { indicator?: Indicator; icon?: string | null } {
  if (input.indicator) return { indicator: input.indicator, icon: iconFor(input.indicator) };
  if (input.icon === undefined) return {};
  if (!input.icon) return { icon: null };
  const i = indicatorOf({ icon: input.icon }, '');
  return i.kind === 'emoji' ? { indicator: i, icon: i.emoji } : { icon: input.icon };
}
