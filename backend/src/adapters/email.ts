/**
 * EmailSender: Resend when RESEND_API_KEY is set; else the dev outbox
 * (_dev/mail/items) under the emulators, and OFF in production (send()
 * throws NotConfiguredError — see notConfigured.ts). The sender address is
 * ours, never user-supplied.
 */
import type { Resend } from 'resend';
import type { EmailMessage, EmailSender } from '@tm/shared';
import { isEmulated } from '../runtime/firebase.js';
import { recordDev } from './dev.js';
import { NotConfiguredError } from './notConfigured.js';

export const DEFAULT_FROM = process.env.EMAIL_FROM ?? 'TaskManager <notify@taskmanager.app>';

export function devEmail(): EmailSender {
  return {
    async send(msg: EmailMessage) {
      const providerId = await recordDev('mail', { ...msg, from: msg.from ?? DEFAULT_FROM });
      return { providerId };
    },
  };
}

export function resendEmail(apiKey: string): EmailSender {
  // Imported lazily so cold starts without a key never load the SDK.
  let client: Promise<Resend> | undefined;
  const get = () => (client ??= import('resend').then((m) => new m.Resend(apiKey)));
  return {
    async send(msg: EmailMessage) {
      const resend = await get();
      const { data, error } = await resend.emails.send({
        from: msg.from ?? DEFAULT_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        ...(msg.headers ? { headers: msg.headers } : {}),
        ...(msg.tag
          ? { tags: [{ name: 'template', value: msg.tag.replace(/[^A-Za-z0-9_-]/g, '_') }] }
          : {}),
      });
      if (error) throw new Error(`Resend: ${error.message}`);
      return { providerId: data?.id ?? null };
    },
  };
}

/** Production without RESEND_API_KEY: nothing is sent, nothing is faked. */
export function offEmail(): EmailSender {
  return {
    async send() {
      throw new NotConfiguredError('email');
    },
  };
}

export function createEmail(): EmailSender {
  const key = process.env.RESEND_API_KEY;
  if (key) return resendEmail(key);
  return isEmulated() ? devEmail() : offEmail();
}
