/**
 * MOUNT POINTS for the doors other steps fill. A door module (auto-imported
 * from src/doors/ and src/doors/hooks/ at cold start) adds routes to its
 * router; createApp() mounts every router after all doors have loaded:
 *
 *   // src/doors/rest.ts (platform step)
 *   import { door } from '../http/mounts.js';
 *   const v1 = door('v1');
 *   v1.use('*', apiKeyAuth);
 *   v1.get('/boards', …);
 *
 * Paths inside a router are relative to its prefix.
 */
import { Hono } from 'hono';
import type { AppEnv } from './env.js';

export const MOUNTS = {
  /** /api/:command — the app door (src/doors/app.ts, api-core). */
  api: '/api',
  /** REST (platform: doors/rest.ts). */
  v1: '/v1',
  /** MCP Streamable HTTP (platform: doors/mcp.ts). */
  mcp: '/mcp',
  /** OAuth 2.1 authorization server (platform: doors/oauth.ts). */
  oauth: '/oauth',
  /** Provider webhooks: /hooks/email, /hooks/whatsapp (notify), /hooks/github (platform). */
  hooks: '/hooks',
  /** OAuth discovery metadata (platform: doors/oauth.ts). */
  wellKnown: '/.well-known',
  /** Calendar feeds /ics/{uid}.{token}.ics (platform: doors/ics.ts). */
  ics: '/ics',
  /** Third-party install flows /integrations/{provider}/connect|callback (platform). */
  integrations: '/integrations',
  /**
   * Artifact files, /c/{capability}/{path} (doors/artifactContent.ts). On the
   * usercontent Hosting site this is the ONLY path that reaches the function.
   */
  content: '/c',
} as const;
export type MountName = keyof typeof MOUNTS;

const routers = new Map<MountName, Hono<AppEnv>>();

/** The router for a mount point (created on first use; shared by every module that asks). */
export function door(name: MountName): Hono<AppEnv> {
  let r = routers.get(name);
  if (!r) {
    r = new Hono<AppEnv>();
    routers.set(name, r);
  }
  return r;
}

export const doorRouters = (): [MountName, Hono<AppEnv>][] => [...routers.entries()];
