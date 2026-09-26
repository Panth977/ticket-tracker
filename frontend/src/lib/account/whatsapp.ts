/** WhatsApp link (Account › Channels): number entry and the OTP step. */

/** '+91 98123 45678' / '0091-98123…' → '+919812345678' (E.164) or null. */
export function toE164(input: string): string | null {
  let s = input.trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** '+919812345678' → '+91 ••••• 45678' for display after linking. */
export function maskNumber(e164: string): string {
  if (e164.length < 8) return e164;
  return `${e164.slice(0, 3)} ••••• ${e164.slice(-5)}`;
}

/** Only digits, at most 6 — the OTP box. */
export function normalizeCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6);
}
