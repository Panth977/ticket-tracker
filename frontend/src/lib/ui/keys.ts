/** Platform-aware key labels: 'mod+k' → '⌘K' on Mac, 'Ctrl+K' elsewhere. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return true;
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad/i.test(p ?? '');
}

const MAC: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  ctrl: '⌃',
  enter: '↵',
  escape: 'Esc',
};
const PC: Record<string, string> = {
  mod: 'Ctrl',
  meta: 'Win',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
  enter: 'Enter',
  escape: 'Esc',
};

export function keyParts(combo: string, mac = isMac()): string[] {
  const map = mac ? MAC : PC;
  return combo
    .split('+')
    .map((k) => map[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k));
}

export function keyLabel(combo: string, mac = isMac()): string {
  return keyParts(combo, mac).join(mac ? '' : '+');
}
