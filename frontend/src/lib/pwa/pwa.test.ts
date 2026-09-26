/**
 * The parts of § S that are decisions rather than browser plumbing: which
 * devices get an install offer, and where the 'New ticket' app shortcut lands.
 */
import { describe, expect, it } from 'vitest';
import type { Board } from '@tm/shared';
import { isIos } from './install.svelte';
import { INTENT, NEW_TICKET, planIntent, withoutIntent } from './shortcuts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126';

const board = (key: string, archivedAt: number | null = null) =>
  ({ id: `b_${key}`, key, name: key, archivedAt }) as unknown as Board;

describe('isIos', () => {
  it('knows an iPhone', () => expect(isIos(IPHONE)).toBe(true));
  it('leaves Android to the real beforeinstallprompt', () => expect(isIos(ANDROID)).toBe(false));
  it('a desktop Mac is not iOS (no touch points in this environment)', () =>
    expect(isIos(IPAD_AS_MAC)).toBe(false));
});

describe('the New ticket shortcut', () => {
  const url = (href: string) => new URL(href, 'https://tasks.example');
  const boards = (list: Board[], loading = false) => ({ list, loading });

  it('ignores a plain launch', () => {
    expect(planIntent(url('/?source=pwa'), boards([board('TM')]))).toEqual({ do: 'nothing' });
  });

  it('waits while the boards are still loading', () => {
    expect(planIntent(url(`/?${INTENT}=${NEW_TICKET}`), boards([], true))).toEqual({ do: 'wait' });
  });

  it('carries the intent to your first live board', () => {
    const plan = planIntent(
      url(`/?${INTENT}=${NEW_TICKET}`),
      boards([board('OLD', 1), board('TM')]),
    );
    expect(plan).toEqual({ do: 'goto', to: `/b/TM?${INTENT}=${NEW_TICKET}` });
  });

  it('sends someone with no board to make one', () => {
    expect(planIntent(url(`/?${INTENT}=${NEW_TICKET}`), boards([board('OLD', 1)]))).toEqual({
      do: 'goto',
      to: '/new-board',
    });
  });

  it('opens quick add once it is on a board', () => {
    expect(planIntent(url(`/b/TM?${INTENT}=${NEW_TICKET}`), boards([board('TM')]))).toEqual({
      do: 'quickAdd',
    });
  });

  it('strips the intent and keeps everything else, so a reload cannot re-fire it', () => {
    expect(withoutIntent(url(`/b/TM/v1?source=pwa&${INTENT}=${NEW_TICKET}&ticket=TM-3#c`))).toBe(
      '/b/TM/v1?source=pwa&ticket=TM-3#c',
    );
  });
});
