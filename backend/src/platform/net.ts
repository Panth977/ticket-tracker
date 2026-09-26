/**
 * Outbound HTTP for webhooks, with the SSRF guard.
 *
 * A webhook URL is chosen by a board admin, and our servers POST to it — so
 * it must never reach our own network: https only, and every address the
 * host resolves to must be public (no loopback, private, link-local — the
 * metadata server lives at 169.254.169.254 — CGNAT, multicast or reserved
 * ranges). The check runs when the webhook is saved AND before each delivery
 * (DNS can change after save: rebinding).
 *
 * `fetch` and `lookup` are swappable so tests can receive deliveries without
 * a real https server or DNS (setNet / resetNet).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { errors } from '@tm/shared';
import { isEmulated } from '../runtime/firebase.js';

export interface Net {
  fetch: typeof fetch;
  /** Every address a hostname resolves to. */
  lookup(host: string): Promise<string[]>;
}

/**
 * DEV SINK (emulators only). A webhook must be https on a public host, so a
 * receiver on this machine can never be saved — the SSRF guard is doing its
 * job. To see real deliveries locally (and in e2e), set
 *   TM_DEV_WEBHOOK_SINK=http://127.0.0.1:5199
 * and save the webhook as https://<anything>.webhook.test/<path>: the
 * reserved .test TLD "resolves" to a documentation-free public placeholder,
 * and every delivery to it is POSTed to the sink with the same path, headers
 * and body instead. Ignored outside the emulators; the guard itself is unchanged.
 */
export const DEV_WEBHOOK_SUFFIX = '.webhook.test';
const DEV_SINK_ADDR = '93.184.215.14';
function devSink(host: string): string | null {
  const sink = process.env.TM_DEV_WEBHOOK_SINK;
  if (!sink || !isEmulated()) return null;
  return host.toLowerCase().endsWith(DEV_WEBHOOK_SUFFIX) ? sink.replace(/\/$/, '') : null;
}

const realNet: Net = {
  fetch: (input, init) => {
    const u = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const sink = devSink(u.hostname);
    return sink ? fetch(sink + u.pathname + u.search, init) : fetch(input, init);
  },
  async lookup(host) {
    if (devSink(host)) return [DEV_SINK_ADDR];
    const res = await dnsLookup(host, { all: true, verbatim: true });
    return res.map((r) => r.address);
  },
};

let current: Net = realNet;
export const net = (): Net => current;
export function setNet(patch: Partial<Net>): void {
  current = { ...current, ...patch };
}
export function resetNet(): void {
  current = realNet;
}

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** True when an IP literal is anything but a public unicast address. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateIp(mapped[1]!);
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8:')) return true;
    return false;
  }
  return true; // not an IP at all: refuse
}

/** Refuse a webhook URL that is not https or resolves anywhere private. Returns the parsed URL. */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw errors.invalid('Not a valid URL', { field: 'url' });
  }
  if (u.protocol !== 'https:') throw errors.invalid('Webhook URLs must be https', { field: 'url' });
  if (u.username || u.password)
    throw errors.invalid('Webhook URLs may not carry credentials', { field: 'url' });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    throw errors.invalid('Webhook URLs must point to a public host', { field: 'url' });
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await net().lookup(host);
    } catch {
      throw errors.invalid(`Could not resolve ${host}`, { field: 'url' });
    }
  }
  if (!addrs.length || addrs.some(isPrivateIp))
    throw errors.invalid(
      'Webhook URLs must point to a public address (private ranges are refused)',
      {
        field: 'url',
      },
    );
  return u;
}
