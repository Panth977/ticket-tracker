/**
 * WhatsappSender: Meta Cloud API when WHATSAPP_TOKEN + WHATSAPP_PHONE_ID are
 * set; else the dev outbox (_dev/whatsapp/items) under the emulators, and OFF
 * in production (every send throws NotConfiguredError).
 */
import type { WhatsappSender } from '@tm/shared';
import { isEmulated } from '../runtime/firebase.js';
import { recordDev } from './dev.js';
import { NotConfiguredError } from './notConfigured.js';

export function devWhatsapp(): WhatsappSender {
  return {
    async sendTemplate(toE164, template, params, lang = 'en') {
      return {
        providerId: await recordDev('whatsapp', {
          kind: 'template',
          to: toE164,
          template,
          params,
          lang,
        }),
      };
    },
    async sendText(toE164, text) {
      return { providerId: await recordDev('whatsapp', { kind: 'text', to: toE164, text }) };
    },
  };
}

export function metaWhatsapp(token: string, phoneId: string, apiVersion = 'v21.0'): WhatsappSender {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;
  async function post(body: unknown): Promise<{ providerId: string | null }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok)
      throw new Error(`WhatsApp ${res.status}: ${json.error?.message ?? 'request failed'}`);
    return { providerId: json.messages?.[0]?.id ?? null };
  }
  const to = (e164: string) => e164.replace(/^\+/, '');
  return {
    sendTemplate(toE164, template, params, lang = 'en') {
      return post({
        messaging_product: 'whatsapp',
        to: to(toE164),
        type: 'template',
        template: {
          name: template,
          language: { code: lang },
          components: params.length
            ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      });
    },
    sendText(toE164, text) {
      return post({
        messaging_product: 'whatsapp',
        to: to(toE164),
        type: 'text',
        text: { body: text, preview_url: true },
      });
    },
  };
}

export function createWhatsapp(): WhatsappSender {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId) return metaWhatsapp(token, phoneId);
  return isEmulated() ? devWhatsapp() : offWhatsapp();
}

/** Production without Meta credentials: nothing is sent, nothing is faked. */
export function offWhatsapp(): WhatsappSender {
  const off = async (): Promise<never> => {
    throw new NotConfiguredError('whatsapp');
  };
  return { sendTemplate: off, sendText: off };
}

/** Whether WhatsApp can actually send (credentials, or the dev outbox under the emulators). */
export const whatsappConfigured = (): boolean =>
  (!!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_ID) || isEmulated();
