/**
 * The device list in Account › Channels: naming a browser, and removing a
 * device other than this one. Registering/enabling push lives in
 * $lib/notifications/push.svelte.ts — one push module, one service worker.
 */
import { deleteDoc, doc } from 'firebase/firestore';
import { paths } from '@tm/shared';
import { getDb } from '$lib/firebase/client';

/** "Chrome on macOS" — enough for someone to recognise their own browser. */
export function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Macintosh|Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'this device';
  return `${browser} on ${os}`;
}

/** Sign one device out of push — the owner can remove any of their own. */
export async function removeDevice(uid: string, deviceId: string): Promise<void> {
  await deleteDoc(doc(getDb(), paths.device(uid, deviceId)));
}
