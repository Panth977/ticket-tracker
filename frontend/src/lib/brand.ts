/**
 * The app's name as this deploy calls it (agents.html § S, "Branding").
 *
 *   PUBLIC_APP_NAME   set per deploy; on a VM the server sets it from
 *                     TM_APP_NAME (backend src/runtime/brand.ts), which also
 *                     renames the static HTML and the PWA manifest.
 *
 * Unset → "TaskManager". Every tab title and the app's own name in the UI read
 * it from here, never a literal.
 */
import { env } from '$env/dynamic/public';

export const APP_NAME = env.PUBLIC_APP_NAME?.trim() || 'TaskManager';
