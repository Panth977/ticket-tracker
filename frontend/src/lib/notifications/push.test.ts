import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
  vi.stubGlobal('window', { Notification: {}, PushManager: {} });
  vi.stubGlobal('navigator', { serviceWorker: {}, userAgent: 'test' });
  vi.stubGlobal('Notification', { permission: 'default' });
  vi.stubGlobal('PushManager', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('push controller', () => {
  it('asks only while permission is default and not dismissed recently', async () => {
    const { push } = await import('./push.svelte');
    expect(push.shouldAsk()).toBe(true);
    push.ask();
    expect(push.asking).toBe(true);
    push.notNow();
    expect(push.asking).toBe(false);
    expect(push.shouldAsk()).toBe(false);
    // 15 days later it may ask again.
    expect(push.shouldAsk(Date.now() + 15 * 24 * 3600 * 1000)).toBe(true);
  });

  it('never asks once granted or denied', async () => {
    const { push } = await import('./push.svelte');
    (Notification as { permission: string }).permission = 'denied';
    expect(push.shouldAsk()).toBe(false);
  });

  it('keeps one device id per browser', async () => {
    const { deviceId } = await import('./push.svelte');
    const a = deviceId();
    expect(a).toMatch(/^web_[0-9a-f]{24}$/);
    expect(deviceId()).toBe(a);
  });
});
