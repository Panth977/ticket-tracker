/**
 * Online/offline. User writes go through the outbox (lib/api/outbox), which
 * waits while offline and resumes on 'online' (agents.html § K); a direct
 * command() still refuses at once while offline.
 */
import { readable } from 'svelte/store';

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export const online = readable(isOnline(), (set) => {
  if (typeof window === 'undefined') return;
  const up = () => set(true);
  const down = () => set(false);
  window.addEventListener('online', up);
  window.addEventListener('offline', down);
  set(isOnline());
  return () => {
    window.removeEventListener('online', up);
    window.removeEventListener('offline', down);
  };
});
