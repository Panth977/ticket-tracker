/**
 * GOOGLE DRIVE in the app (docs/plan/bucket.html §K): my connection, the
 * round trip to Google's consent page, and Google's folder picker.
 *
 *   driveState         driveStatus, loaded once per session, refreshed after
 *                      connect / disconnect
 *   connectDrive()     → driveConnect → Google → /integrations/drive/callback →
 *                      back here with ?drive=connected (or ?drive=error)
 *   pickDriveFolder()  Google Picker (folders only) with a short-lived token
 *                      from drivePickerToken; picking GRANTS the app that
 *                      folder under drive.file
 *
 * Nothing here holds a refresh token: the server does (link.ts).
 */
import type { CommandRes } from '@tm/shared';
import { command } from '$lib/api';

type Status = CommandRes<'driveStatus'>;

class DriveState {
  status = $state<Status | null>(null);
  loading = $state(false);
  #pending: Promise<Status | null> | null = null;

  /** Load (once) — pass force after connect / disconnect. */
  load(force = false): Promise<Status | null> {
    if (this.#pending && !force) return this.#pending;
    this.loading = true;
    this.#pending = command('driveStatus', {}, { toast: false })
      .then((s) => (this.status = s))
      .catch(() => (this.status = null))
      .finally(() => (this.loading = false));
    return this.#pending;
  }
}

export const driveState = new DriveState();

/** Off to Google's consent page; back to `returnTo` (default: where I am). */
export async function connectDrive(returnTo?: string): Promise<void> {
  const here = returnTo ?? `${location.pathname}${location.search}`;
  const { url } = await command(
    'driveConnect',
    { returnTo: stripDriveParams(here) },
    { toast: 'Could not start connecting Google Drive' },
  );
  location.assign(url);
}

export async function disconnectDrive(): Promise<void> {
  await command('driveDisconnect', {}, { toast: 'Could not disconnect Google Drive' });
  await driveState.load(true);
}

/** ?drive=connected|error&reason=… as the callback appends them — read once, then dropped. */
export function takeDriveResult(): { ok: boolean; reason: string | null } | null {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-off parse, not state
  const u = new URL(location.href);
  const v = u.searchParams.get('drive');
  if (!v) return null;
  const reason = u.searchParams.get('reason');
  history.replaceState(history.state, '', stripDriveParams(`${u.pathname}${u.search}`) + u.hash);
  return { ok: v === 'connected', reason };
}

function stripDriveParams(path: string): string {
  const u = new URL(path, 'http://x');
  u.searchParams.delete('drive');
  u.searchParams.delete('reason');
  return `${u.pathname}${u.search}`;
}

// ── Google Picker ────────────────────────────────────────────────────────────

/* Just what we call of Google's picker API (loaded from apis.google.com). */
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setCallback(fn: (data: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface PickerResponse {
  action: string;
  docs?: { id: string; name: string; mimeType: string }[];
}
interface GooglePicker {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: string) => {
    setIncludeFolders(v: boolean): unknown;
    setSelectFolderEnabled(v: boolean): unknown;
    setMimeTypes(m: string): unknown;
  };
  ViewId: { FOLDERS: string };
  Action: { PICKED: string; CANCEL: string };
}
declare global {
  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: { picker?: GooglePicker };
  }
}

let loader: Promise<GooglePicker> | null = null;
function loadPicker(): Promise<GooglePicker> {
  return (loader ??= new Promise<GooglePicker>((resolve, reject) => {
    const done = () =>
      window.gapi!.load('picker', () =>
        window.google?.picker ? resolve(window.google.picker) : reject(new Error('No picker')),
      );
    if (window.gapi) return done();
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = done;
    s.onerror = () => {
      loader = null;
      reject(new Error('Could not load Google’s picker'));
    };
    document.head.appendChild(s);
  }));
}

/** Pick a folder in my Drive. null when cancelled. */
export async function pickDriveFolder(): Promise<{ id: string; name: string } | null> {
  const [picker, tok] = await Promise.all([
    loadPicker(),
    command('drivePickerToken', {}, { toast: 'Could not open the Drive picker' }),
  ]);
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(true);
    view.setMimeTypes('application/vnd.google-apps.folder');
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(tok.accessToken)
      .setDeveloperKey(tok.apiKey)
      .setAppId(tok.appId)
      .setTitle('Choose the folder for this bucket')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0])
          resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
