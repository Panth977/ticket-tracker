/**
 * Server features the SPA must know about before calling them.
 *
 *   PUBLIC_WHATSAPP_ENABLED  true once the backend has WHATSAPP_TOKEN +
 *                            WHATSAPP_PHONE_ID. Unset in production → the
 *                            WhatsApp channel is greyed out (linking would
 *                            only answer 503). Always on under the emulators,
 *                            where the backend's dev outbox stands in.
 */
import { env } from '$env/dynamic/public';
import { USE_EMULATORS } from '$lib/firebase/config';

const on = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

export const WHATSAPP_ENABLED = USE_EMULATORS || on(env.PUBLIC_WHATSAPP_ENABLED);
