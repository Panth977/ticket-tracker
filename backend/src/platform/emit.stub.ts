/**
 * No-op emitWebhook(), matching the shared EmitWebhookFn signature. Commands
 * import `emitWebhook` from './emit.js' (never from this file); the platform
 * step replaces the implementation behind that module, not the import path.
 */
import type { EmitWebhookFn } from '@tm/shared';

export const emitWebhookStub: EmitWebhookFn = async () => {};
