let n = 0;
/** A unique DOM id for label/aria wiring. */
export function uid(prefix = 'tm'): string {
  return `${prefix}-${++n}`;
}
