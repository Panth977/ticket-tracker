/** Pure helpers for showing a person (no Firebase). */

/** 'Panth Patel' → 'PP', 'priya' → 'P', '' → '?' */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

const HUES = [210, 262, 330, 20, 45, 150, 180, 290];

/** A stable hue for someone without a picture, from their uid. */
export function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length]!;
}

/** 'priya@acme.com' → 'p***@acme.com' (the invite screen's wrong-account hint). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  return email[0] + '***' + email.slice(at);
}
