/**
 * Off-by-default third-party channels. In production (not under the
 * emulators) a channel whose credentials are absent is NOT faked — the dev
 * outbox (_dev/*) is for local development only — it refuses with
 * NotConfiguredError instead, and callers record the attempt as
 * 'suppressed: not configured' (deliveries/) or answer 503.
 *
 *   email     RESEND_API_KEY                    (adapters/email.ts)
 *   whatsapp  WHATSAPP_TOKEN + WHATSAPP_PHONE_ID (adapters/whatsapp.ts)
 *   search    TYPESENSE_HOST + TYPESENSE_API_KEY (search/index.ts: Firestore fallback)
 *   github    GITHUB_WEBHOOK_SECRET / GITHUB_APP_SLUG (doors/hooks/github.ts, platform/integrations.ts)
 */
export const NOT_CONFIGURED = 'suppressed: not configured';

export class NotConfiguredError extends Error {
  readonly code = 'not-configured';
  constructor(readonly channel: string) {
    super(`${channel} is not configured on this server`);
    this.name = 'NotConfiguredError';
  }
}

export const isNotConfigured = (e: unknown): e is NotConfiguredError =>
  e instanceof NotConfiguredError || (e as { code?: string } | null)?.code === 'not-configured';
