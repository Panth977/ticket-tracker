/**
 * Flow: "A webhook delivery" (platform/flows.json). A real HTTP receiver on
 * this machine gets the deliveries: the webhook is saved as
 * https://<id>.webhook.test/… and the backend's dev sink
 * (TM_DEV_WEBHOOK_SINK, set by scripts/dev.mjs) forwards every delivery to
 * it — through the real queue (tasks emulator → queueWebhooks), signed with
 * the real secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { signaturePayload, parseSignatureHeader } from '@tm/shared';
// @ts-expect-error — plain .mjs shared with the root scripts
import { PORTS } from '../../../scripts/ports.mjs';
import { call, eventually, newBoard, newPerson, stage } from '../support/stack.js';

interface Hit {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const hits: Hit[] = [];
let server: Server;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen((PORTS as { webhookSink: number }).webhookSink, '127.0.0.1', resolve);
  });
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

function verify(secret: string, hit: Hit): boolean {
  const sig = parseSignatureHeader(String(hit.headers['x-tm-signature'] ?? ''));
  if (!sig) return false;
  const want = createHmac('sha256', secret).update(signaturePayload(sig.t, hit.body)).digest('hex');
  return want.length === sig.v1.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig.v1));
}

test('webhook: ping on save, signed ticket.created and ticket.moved deliveries to a local receiver', async () => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const path = `/hook-${b.key.toLowerCase()}`;
  const url = `https://${b.key.toLowerCase()}.webhook.test${path}`;

  const saved = await call(ada, 'webhookUpsert', {
    boardId: b.id,
    url,
    events: ['ticket.created', 'ticket.moved'],
  });
  expect(saved.secret).toBeTruthy();
  expect(saved.ping).toMatchObject({ ok: true, status: 200 });
  const secret = saved.secret!;
  const mine = () => hits.filter((h) => h.path === path);

  const ping = await eventually('ping', async () =>
    mine().find((h) => h.headers['x-tm-event'] === 'ping'),
  );
  expect(verify(secret, ping)).toBe(true);

  const { ticketId, key } = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Hooked',
    stageId: stage(b, 'To do'),
  });
  const created = await eventually('ticket.created', async () =>
    mine().find((h) => h.headers['x-tm-event'] === 'ticket.created'),
  );
  expect(verify(secret, created)).toBe(true);
  expect(created.headers['x-tm-delivery']).toBeTruthy();
  const env = JSON.parse(created.body);
  expect(env).toMatchObject({
    type: 'ticket.created',
    data: { id: ticketId, key, title: 'Hooked', board: { key: b.key } },
  });

  await call(ada, 'ticketUpdate', {
    boardId: b.id,
    ticketId,
    patch: { stageId: stage(b, 'In progress') },
  });
  const moved = await eventually('ticket.moved', async () =>
    mine().find((h) => h.headers['x-tm-event'] === 'ticket.moved'),
  );
  expect(verify(secret, moved)).toBe(true);
  expect(JSON.parse(moved.body).data).toMatchObject({
    key,
    stage: { name: 'In progress' },
    from_stage: { name: 'To do' },
  });

  // a tampered body does not verify
  expect(verify(secret, { ...moved, body: moved.body.replace('In progress', 'Done') })).toBe(false);
});

test('webhook: a private address is refused (the SSRF guard is not bypassed by the dev sink)', async () => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  await expect(
    call(ada, 'webhookUpsert', {
      boardId: b.id,
      url: 'https://127.0.0.1/hook',
      events: ['ticket.created'],
    }),
  ).rejects.toMatchObject({
    status: 400,
  });
});
