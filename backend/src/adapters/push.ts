/**
 * PushSender: FCM (Admin messaging) in production; the dev outbox
 * (_dev/push/items) under the emulators or when TM_PUSH=dev — FCM has no
 * emulator and demo projects cannot reach it.
 *
 * Dev fake convention: a token starting with 'unregistered' answers
 * `unregistered: true`, so callers' token cleanup is testable.
 */
import { getMessaging } from 'firebase-admin/messaging';
import type { PushMessage, PushResult, PushSender } from '@tm/shared';
import { adminApp, isEmulated } from '../runtime/firebase.js';
import { recordDev } from './dev.js';

export function devPush(): PushSender {
  return {
    async send(tokens: string[], msg: PushMessage): Promise<PushResult[]> {
      if (tokens.length === 0) return [];
      const id = await recordDev('push', { tokens, ...msg });
      return tokens.map((token) =>
        token.startsWith('unregistered')
          ? {
              token,
              ok: false,
              unregistered: true,
              error: 'messaging/registration-token-not-registered',
            }
          : { token, ok: true, providerId: id },
      );
    },
  };
}

export function fcmPush(): PushSender {
  return {
    async send(tokens: string[], msg: PushMessage): Promise<PushResult[]> {
      if (tokens.length === 0) return [];
      const data: Record<string, string> = {
        ...(msg.data ?? {}),
        ...(msg.url ? { url: msg.url } : {}),
      };
      const res = await getMessaging(adminApp()).sendEach(
        tokens.map((token) => ({
          token,
          notification: { title: msg.title, body: msg.body },
          data,
          webpush: {
            notification: {
              title: msg.title,
              body: msg.body,
              ...(msg.tag ? { tag: msg.tag, renotify: true } : {}),
            },
            ...(msg.url ? { fcmOptions: { link: msg.url } } : {}),
          },
        })),
      );
      return res.responses.map((r, i) => {
        const token = tokens[i]!;
        if (r.success) return { token, ok: true, providerId: r.messageId ?? null };
        const code = r.error?.code ?? '';
        return {
          token,
          ok: false,
          unregistered:
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token',
          error: code || r.error?.message || 'unknown',
        };
      });
    },
  };
}

export function createPush(): PushSender {
  if (process.env.TM_PUSH === 'fcm') return fcmPush();
  if (process.env.TM_PUSH === 'dev' || isEmulated()) return devPush();
  return fcmPush();
}
