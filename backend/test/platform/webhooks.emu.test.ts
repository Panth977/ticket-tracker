/**
 * Webhooks: webhookUpsert (SSRF guard, secret shown once, ping), the real
 * emitWebhook → fan-out → signed delivery, retries on our own schedule,
 * give-up, and auto-disable after 20 consecutive failures.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  paths,
  parseSignatureHeader,
  signaturePayload,
  WEBHOOK_MAX_FAILURES,
  type Envelope,
  type WebhookDelivery,
} from '@tm/shared';
import { hmacHex, sha256hex } from '../../src/platform/crypto.js';
import { resetNet, setNet, isPrivateIp } from '../../src/platform/net.js';
import { MAX_ATTEMPTS } from '../../src/platform/webhooks.js';
import { db } from '../../src/runtime/firebase.js';
import { call, devOutbox, queue, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { apiKeyFor, rest } from './helpers.js';

setupEmulators();
afterEach(() => resetNet());

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake receiver on a public address answering with `status()`. */
function receiver(status: () => number = () => 200): Received[] {
  const got: Received[] = [];
  setNet({
    lookup: async () => ['93.184.216.34'],
    fetch: (async (url: string, init: RequestInit) => {
      got.push({
        url: String(url),
        headers: Object.fromEntries(
          Object.entries(init.headers as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body: String(init.body),
      });
      return new Response('thanks', { status: status() });
    }) as typeof fetch,
  });
  return got;
}

const deliveries = async (boardId: string, webhookId: string) =>
  (await db().collection(paths.webhookDeliveries(boardId, webhookId)).get()).docs
    .map((d) => d.data() as WebhookDelivery)
    .sort((a, b) => a.attempt - b.attempt || a.createdAt - b.createdAt);

describe('SSRF guard', () => {
  it('classifies private and public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.1',
      '172.16.5.5',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('refuses http, private hosts and names that resolve privately', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    const up = (url: string) =>
      call(admin, 'webhookUpsert', { boardId: b.id, url, events: ['ticket.created'] });
    await expect(up('http://example.com/hook')).rejects.toMatchObject({ code: 'invalid' });
    await expect(up('https://127.0.0.1/hook')).rejects.toMatchObject({ code: 'invalid' });
    await expect(up('https://localhost/hook')).rejects.toMatchObject({ code: 'invalid' });
    setNet({ lookup: async () => ['10.0.0.8'] });
    await expect(up('https://internal.example.com/hook')).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('webhookUpsert', () => {
  it('admin only; secret shown once and stored as a hash; the ping is signed', async () => {
    const { admin, ed } = await people('admin', 'ed');
    const b = await seedBoard({ admin, editors: [ed] });
    const got = receiver();
    await expect(
      call(ed, 'webhookUpsert', {
        boardId: b.id,
        url: 'https://hooks.example.com/tm',
        events: ['ticket.created'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const res = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://hooks.example.com/tm',
      events: ['ticket.created'],
    });
    expect(res.secret).toMatch(/^whsec_/);
    expect(res.ping).toEqual({ ok: true, status: 200 });
    const stored = (await db().doc(paths.webhook(b.id, res.webhookId)).get()).data()!;
    expect(stored.secretHash).toBe(sha256hex(res.secret!));
    expect(JSON.stringify(stored)).not.toContain(res.secret!);

    expect(got).toHaveLength(1);
    const ping = got[0]!;
    expect(ping.headers['x-tm-event']).toBe('ping');
    const sig = parseSignatureHeader(ping.headers['x-tm-signature']!)!;
    expect(sig.v1).toBe(hmacHex(res.secret!, signaturePayload(sig.t, ping.body)));
    expect((JSON.parse(ping.body) as Envelope).data).toEqual({ webhook_id: res.webhookId });

    // Update without rotating: no secret; rotating: a new one.
    const upd = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      webhookId: res.webhookId,
      url: 'https://hooks.example.com/tm',
      events: ['ticket.created', 'ticket.moved'],
    });
    expect(upd.secret).toBeUndefined();
    const rot = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      webhookId: res.webhookId,
      url: 'https://hooks.example.com/tm',
      events: ['ticket.created'],
      rotateSecret: true,
    });
    expect(rot.secret).toMatch(/^whsec_/);
    expect(rot.secret).not.toBe(res.secret);
  });

  it('saves even when the ping fails, but says so', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    receiver(() => 500);
    const res = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://down.example.com/',
      events: ['ticket.created'],
    });
    expect(res.ping).toEqual({ ok: false, status: 500 });
    expect((await db().doc(paths.webhook(b.id, res.webhookId)).get()).exists).toBe(true);
  });
});

describe('dispatch', () => {
  it('a ticket created through the app fans out to matching webhooks only, signed', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    const got = receiver();
    const a = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://a.example.com/',
      events: ['ticket.created'],
    });
    await call(admin, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://b.example.com/',
      events: ['message.created'],
    });
    got.length = 0;

    const t = await call(admin, 'ticketCreate', { boardId: b.id, title: 'Hello hooks' });
    await queue().drain({ queue: 'webhooks' });

    expect(got.map((g) => g.url)).toEqual(['https://a.example.com/']);
    const env = JSON.parse(got[0]!.body) as Envelope<{ key: string }>;
    expect(env).toMatchObject({
      type: 'ticket.created',
      boardId: b.id,
      actor: { id: admin.uid, via: 'app' },
    });
    expect(env.id).toMatch(/^evt_/);
    expect(env.data.key).toBe(t.key);
    expect(got[0]!.headers['x-tm-delivery']).toBe(`${env.id}-1`);
    const sig = parseSignatureHeader(got[0]!.headers['x-tm-signature']!)!;
    expect(sig.v1).toBe(hmacHex(a.secret!, signaturePayload(sig.t, got[0]!.body)));

    const rows = await deliveries(b.id, a.webhookId);
    expect(rows.filter((r) => r.event === 'ticket.created').map((r) => r.status)).toEqual(['ok']);
  });

  it('retries on its own schedule, then gives up; 20 consecutive give-ups disable and email the owner', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    let status = 200;
    const got = receiver(() => status);
    const a = await call(admin, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://flaky.example.com/',
      events: ['ticket.created'],
    });
    status = 503;
    await call(admin, 'ticketCreate', { boardId: b.id, title: 'Retry me' });
    const before = got.length;
    await queue().drain({ queue: 'webhooks' });
    expect(got.length - before).toBe(MAX_ATTEMPTS);

    const rows = (await deliveries(b.id, a.webhookId)).filter((r) => r.event === 'ticket.created');
    expect(rows.map((r) => r.status)).toEqual([
      ...Array(MAX_ATTEMPTS - 1).fill('failed'),
      'gave_up',
    ]);
    expect(rows[0]!.nextAttemptAt! - rows[0]!.createdAt).toBe(60_000);
    expect(rows[1]!.nextAttemptAt! - rows[1]!.createdAt).toBe(5 * 60_000);
    expect(rows.at(-1)!.responseCode).toBe(503);
    expect(rows.at(-1)!.responseSnippet).toBe('thanks');
    let hook = (await db().doc(paths.webhook(b.id, a.webhookId)).get()).data()!;
    expect(hook.failures).toBe(1);

    // One short of the limit, then one more give-up switches it off.
    await db()
      .doc(paths.webhook(b.id, a.webhookId))
      .update({ failures: WEBHOOK_MAX_FAILURES - 1 });
    await call(admin, 'ticketCreate', { boardId: b.id, title: 'And again' });
    await queue().drain({ queue: 'webhooks' });
    hook = (await db().doc(paths.webhook(b.id, a.webhookId)).get()).data()!;
    expect(hook).toMatchObject({ failures: WEBHOOK_MAX_FAILURES, active: false });
    const mail = await devOutbox<{ to: string; tag: string }>('mail', {
      field: 'to',
      equals: admin.email,
    });
    expect(mail.some((m) => m.tag === 'webhook-disabled')).toBe(true);

    // Disabled: nothing more is sent. A success after re-enabling resets the count.
    const n = got.length;
    await call(admin, 'ticketCreate', { boardId: b.id, title: 'Silent' });
    await queue().drain({ queue: 'webhooks' });
    expect(got.length).toBe(n);
    status = 200;
    await call(admin, 'webhookUpsert', {
      boardId: b.id,
      webhookId: a.webhookId,
      url: 'https://flaky.example.com/',
      events: ['ticket.created'],
      active: true,
    });
    hook = (await db().doc(paths.webhook(b.id, a.webhookId)).get()).data()!;
    expect(hook).toMatchObject({ failures: 0, active: true });
  });

  it('CRUD through /v1/webhooks with webhooks:manage', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    receiver();
    const { key } = await apiKeyFor(admin, ['webhooks:manage'], b.id);
    const made = await rest(key, 'POST', '/v1/webhooks', {
      board: b.key,
      url: 'https://c.example.com/',
      events: ['ticket.moved'],
    });
    expect(made.status).toBe(201);
    const w = made.body as { id: string; secret: string; board: string };
    expect(w.secret).toMatch(/^whsec_/);
    expect(w.board).toBe(b.key);
    const list = await rest(key, 'GET', `/v1/webhooks?board=${b.key}`);
    expect((list.body as { data: { id: string }[] }).data.map((x) => x.id)).toEqual([w.id]);
    const patched = await rest(key, 'PATCH', `/v1/webhooks/${w.id}`, { active: false });
    expect(patched.body).toMatchObject({ active: false, events: ['ticket.moved'] });
    expect((await rest(key, 'DELETE', `/v1/webhooks/${w.id}`)).status).toBe(204);
    expect((await db().doc(paths.webhook(b.id, w.id)).get()).exists).toBe(false);
    expect((await rest(key, 'DELETE', `/v1/webhooks/${w.id}`)).status).toBe(404);
  });
});
