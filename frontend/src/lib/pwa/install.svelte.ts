/**
 * Installing TaskManager on a phone (docs/plan/agents.html § S).
 *
 *   NEVER A BANNER  Chrome's own mini-infobar is cancelled in app.html and the
 *                   event kept there (window.__tmInstall) so it survives the
 *                   time before the Shell mounts. We offer Install ONCE, from
 *                   the account menu, and remember a dismissal per device — it
 *                   never asks again on that browser.
 *   iOS             gives no event at all: Safari installs only through
 *                   Share › Add to Home Screen, and nothing on the page can
 *                   trigger it. There the same menu entry explains those two
 *                   taps instead — as the app's own sticky toast, because the
 *                   account menu is mounted twice on a phone (the hidden
 *                   sidebar and the ☰ drawer) and a dialog would be too.
 *   ALREADY THERE   once the app runs standalone (display-mode, or Safari's
 *                   navigator.standalone) the entry disappears for good.
 */

import { toast } from '$lib/ui';

const DISMISS_KEY = 'tm.pwa.installDismissed';
const HELP_KEY = 'tm.pwa.iosHelp';

/** Chrome's BeforeInstallPromptEvent — not in lib.dom. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallWindow extends Window {
  __tmInstall?: InstallPromptEvent | null;
}

/** How this device can install, if at all. */
export type InstallKind = 'prompt' | 'ios' | 'none';

function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // private mode
  }
}

/** Running as an installed app, on any of the three spellings browsers use. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    ['standalone', 'minimal-ui', 'fullscreen'].some(
      (m) => matchMedia(`(display-mode: ${m})`).matches,
    )
  );
}

/**
 * iPhone / iPad, including iPadOS 13+, which reports itself as a Mac and is
 * told apart by the touch points. Every browser on iOS is Safari underneath,
 * so this covers Chrome and Firefox there too.
 */
export function isIos(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return (
    /Macintosh/.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1
  );
}

export function dismissed(): boolean {
  return ls()?.getItem(DISMISS_KEY) === '1';
}

class InstallController {
  /** The captured beforeinstallprompt, if Chrome has fired it. */
  private event = $state<InstallPromptEvent | null>(null);
  /** Standalone / dismissed are re-read on start(), so they are state too. */
  private standalone = $state(false);
  private hidden = $state(false);
  readonly kind: InstallKind = $derived(this.event ? 'prompt' : isIos() ? 'ios' : 'none');

  /** Show the account-menu entry? */
  readonly offer: boolean = $derived(!this.standalone && !this.hidden && this.kind !== 'none');

  /** Idempotent; returns a teardown. Called by the account menu (it mounts with the Shell). */
  start(): () => void {
    if (typeof window === 'undefined') return () => {};
    const w = window as InstallWindow;
    this.standalone = isStandalone();
    this.hidden = dismissed();
    this.event = w.__tmInstall ?? null;

    const onInstallable = () => (this.event = w.__tmInstall ?? null);
    const onInstalled = () => {
      this.event = null;
      this.standalone = true;
    };
    window.addEventListener('tm:installable', onInstallable);
    window.addEventListener('tm:installed', onInstalled);
    return () => {
      window.removeEventListener('tm:installable', onInstallable);
      window.removeEventListener('tm:installed', onInstalled);
    };
  }

  /**
   * The menu entry. Chrome: show the real prompt (it can only be shown once per
   * event, so we drop it either way). iOS: explain the Share-menu path.
   */
  async choose(): Promise<'accepted' | 'dismissed' | 'help'> {
    const e = this.event;
    if (!e) {
      this.explainIos();
      return 'help';
    }
    this.event = null;
    await e.prompt();
    const { outcome } = await e.userChoice;
    // "Not now" on the OS prompt is a decision about this device: honour it.
    if (outcome === 'dismissed') this.dismiss();
    (window as InstallWindow).__tmInstall = null;
    return outcome;
  }

  /** iOS's install path, in the app's own words — it has no prompt to show. */
  explainIos(): void {
    toast.show({
      key: HELP_KEY,
      kind: 'info',
      message: 'Add TaskManager to your Home Screen',
      detail:
        'iPhone and iPad install web apps from the browser’s Share menu — no site can do it for you. ' +
        'Tap Share (the square with an arrow), then “Add to Home Screen”, then Add.',
      duration: 0,
      actions: [
        { label: 'Got it', run: () => {} },
        { label: 'Don’t show again', tone: 'muted', run: () => this.dismiss() },
      ],
    });
  }

  /** Never ask again on this device. */
  dismiss(): void {
    this.hidden = true;
    try {
      ls()?.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: the offer simply comes back next time */
    }
  }
}

export const install = new InstallController();
