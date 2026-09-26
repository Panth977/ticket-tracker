/** Number formatting / parsing for custom fields (pure, tested). */
import type { FieldDef } from '@tm/shared';

/** '1,234.5' / '1 234,5' / '12%' / '$ 40' → a number, or null. */
export function parseNumberInput(raw: string): number | null {
  let s = raw.trim().replace(/[%\s]|[^\d.,\-+eE]/g, '');
  if (!s) return null;
  // '1.234,5' (decimal comma) vs '1,234.5' (thousands comma): the LAST separator is the decimal one.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(n: number, def?: Pick<FieldDef, 'type' | 'config'>): string {
  const p = def?.config?.precision;
  const s = n.toLocaleString(
    undefined,
    p != null ? { minimumFractionDigits: p, maximumFractionDigits: p } : undefined,
  );
  if (def?.type === 'percent') return `${s}%`;
  if (def?.type === 'currency' && def.config?.currency) return `${def.config.currency} ${s}`;
  return s;
}
