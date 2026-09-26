/**
 * The two-way channels through the real hono app: /hooks/email (replies,
 * email-to-board, one-click unsubscribe), /hooks/whatsapp (statuses, STOP,
 * buttons, replies) and the whatsappLink OTP command. Ticket commands belong
 * to another step, so their calls are observed through setCommandInvoker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, defaultChannelMatrix, paths, type Delivery, type Intake } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import { setCommandInvoker } from '../../src/notify/commands.js';
import { clientIdFrom, signMeta, signSvix } from '../../src/notify/inbound.js';
import { replyAddress, replyToken, unsubscribeToken } from '../../src/notify/tokens.js';
import type { ServerCtx } from '../../src/runtime/context.js';
import { typedDoc } from '../../src/runtime/index.js';
import { call, createUser, request, setupEmulators, uniq } from '../harness/index.js';
import { seedBoard, seedTicket, seedUser, T, useFakes } from './_seed.js';

setupEmulators();

interface Call {
  name: string;
  input: Record<string, unknown>;
  ctx: ServerCtx;
}
let calls: Call[] = [];
function observeCommands(
  result: (c: Call) => unknown = () => ({ messageId: 'm-new', ticketId: 'tk', key: 'ENG-99' }),
) {
  calls = [];
  setCommandInvoker(async (name, input, ctx) => {
    const c = { name, input: input as Record<string, unknown>, ctx };
    calls.push(c);
    return result(c);
  });
}
afterEach(() => {
  setCommandInvoker();
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const outcome = (r: { body: unknown }) =>
  (r.body as { outcome: { kind: string; reason?: string } }).outcome;

async function thread(over: { emailReplies?: boolean; expiresAt?: number } = {}) {
  const f = useFakes();
  const u = await seedUser({ email: `${uniq('r')}@test.dev` });
  const other = await seedUser();
  const board = await seedBoard([u.uid, other.uid], {
    settings: {
      allowDelete: false,
      emailReplies: over.emailReplies ?? true,
      autoArchiveDoneAfterDays: null,
    },
  });
  await typedDoc('members', paths.member(board.id, other.uid)).set({
    ...fixtures.members,
    uid: other.uid,
    email: other.email,
    role: 'editor',
    stageGrant: null,
  });
  const t = await seedTicket(board.id);
  const token = replyToken(u.uid, t.id);
  await typedDoc('emailThreads', paths.emailThread(token)).set({
    boardId: board.id,
    ticketId: t.id,
    uid: u.uid,
    messageIdHeader: `<ticket-${t.id}@taskmanager.app>`,
    expiresAt: over.expiresAt ?? T + 1000,
  });
  return { f, u, other, board, t, to: replyAddress(token) };
}

describe('/hooks/email — replies', () => {
  it('posts the reply (quote and signature stripped, @email resolved, attachments stored) as the thread owner via email', async () => {
    const { f, u, other, board, t, to } = await thread();
    observeCommands();
    const r = await post('/hooks/email', {
      type: 'email.received',
      data: {
        from: `U Person <${u.email.toUpperCase()}>`,
        to: [to],
        subject: 'Re: whatever',
        text: `Sounds good, cc @${other.email}\n\n-- \nU\n\nOn Tue, Sep 22, 2026 at 5:00 PM Priya wrote:\n> old stuff`,
        headers: { 'Message-ID': '<abc@mail.test>' },
        attachments: [
          {
            filename: '../../evil name?.txt',
            content_type: 'text/plain',
            content: Buffer.from('hi').toString('base64'),
          },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(outcome(r)).toMatchObject({ kind: 'reply', ticketId: t.id, messageId: 'm-new' });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.name).toBe('messagePost');
    expect(c.ctx).toMatchObject({ actor: u.uid, via: 'email', now: T });
    expect(c.input.clientId).toBe(clientIdFrom('em', '<abc@mail.test>'));
    const bodyJson = JSON.stringify(c.input.body);
    expect(bodyJson).toContain('Sounds good');
    expect(bodyJson).not.toContain('old stuff');
    expect(bodyJson).toContain(`"uid":"${other.uid}"`); // the @email became a mention
    const [path] = c.input.attachments as string[];
    expect(path).toMatch(new RegExp(`^boards/${board.id}/tickets/${t.id}/[^/]+/evil name_.txt$`));
    expect(f.files.get(path!)).toBe('text/plain');
  });

  it('drops a reply From someone else, to an expired thread, or to a board without email replies', async () => {
    const a = await thread();
    observeCommands();
    const r1 = await post('/hooks/email', { from: 'intruder@evil.test', to: a.to, text: 'hi' });
    expect(outcome(r1)).toMatchObject({
      kind: 'dropped',
      reason: 'sender does not own this thread',
    });

    const b = await thread({ expiresAt: T - 1 });
    const r2 = await post('/hooks/email', { from: b.u.email, to: b.to, text: 'hi' });
    expect(outcome(r2)).toMatchObject({ kind: 'dropped', reason: 'unknown or expired thread' });

    const c = await thread({ emailReplies: false });
    const r3 = await post('/hooks/email', { from: c.u.email, to: c.to, text: 'hi' });
    expect(outcome(r3)).toMatchObject({
      kind: 'dropped',
      reason: 'board does not accept email replies',
    });

    const r4 = await post('/hooks/email', {
      from: c.u.email,
      to: 'nobody@elsewhere.test',
      text: 'hi',
    });
    expect(outcome(r4)).toMatchObject({ kind: 'dropped', reason: 'no known recipient' });
    expect(calls).toHaveLength(0);
  });

  it('a command refusal (e.g. closed ticket) is dropped, not retried', async () => {
    const { u, to } = await thread();
    observeCommands(() => {
      throw new AppError('conflict', 'closed');
    });
    const r = await post('/hooks/email', { from: u.email, to, text: 'late reply' });
    expect(r.status).toBe(200);
    expect(outcome(r)).toMatchObject({ kind: 'dropped', reason: 'messagePost refused: conflict' });
  });
});

describe('/hooks/email — email-to-board', () => {
  it('creates a ticket from the intake address with its defaults', async () => {
    useFakes();
    const u = await seedUser();
    const board = await seedBoard([u.uid]);
    const slug = uniq('in');
    const address = `${slug}@in.taskmanager.app`;
    const it0: Intake = {
      ...fixtures.intakes,
      boardId: board.id,
      enabled: true,
      email: address,
      defaults: { stageId: 'st_todo', tagIds: ['tg_bug'], assigneeUids: [u.uid] },
    };
    await typedDoc('intakes', paths.intake(slug)).set(it0);
    observeCommands();
    const r = await post('/hooks/email', {
      from: 'Carol Customer <carol@customer.test>',
      to: [`Bugs <${address.toUpperCase()}>`],
      subject: 'Checkout is broken',
      html: '<p>It fails <b>every</b> time.</p><blockquote>quoted</blockquote>',
      message_id: '<m1@customer.test>',
    });
    expect(outcome(r)).toMatchObject({ kind: 'ticket', ticketId: 'tk', key: 'ENG-99' });
    const c = calls[0]!;
    expect(c.name).toBe('ticketCreate');
    expect(c.ctx).toMatchObject({ actor: 'intake-bot', via: 'email' });
    expect(c.input).toMatchObject({
      boardId: board.id,
      title: 'Checkout is broken',
      stageId: 'st_todo',
      tagIds: ['tg_bug'],
      assigneeUids: [u.uid],
      clientId: clientIdFrom('ei', '<m1@customer.test>'),
    });
    const desc = JSON.stringify(c.input.description);
    expect(desc).toContain('carol@customer.test');
    expect(desc).toContain('every');
    expect(desc).not.toContain('quoted');

    await typedDoc('intakes', paths.intake(slug)).update({ enabled: false });
    const r2 = await post('/hooks/email', {
      from: 'carol@customer.test',
      to: address,
      subject: 'x',
    });
    expect(outcome(r2)).toMatchObject({ kind: 'dropped' });
  });
});

describe('/hooks/email — signature and unsubscribe', () => {
  it('with RESEND_WEBHOOK_SECRET set, unsigned or tampered bodies are 401', async () => {
    useFakes();
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('shh-secret').toString('base64');
    const body = JSON.stringify({ from: 'a@b.test', to: 'x@elsewhere.test', text: 'hi' });
    const bad = await request('/hooks/email', { method: 'POST', body });
    expect(bad.status).toBe(401);
    const ts = Math.floor(T / 1000);
    const headers = signSvix(body, process.env.RESEND_WEBHOOK_SECRET, 'msg_1', ts);
    const ok = await request('/hooks/email', { method: 'POST', headers, body });
    expect(ok.status).toBe(200);
    const tampered = await request('/hooks/email', {
      method: 'POST',
      headers,
      body: body.replace('hi', 'yo'),
    });
    expect(tampered.status).toBe(401);
    const stale = signSvix(body, process.env.RESEND_WEBHOOK_SECRET, 'msg_1', ts - 3600);
    expect((await request('/hooks/email', { method: 'POST', headers: stale, body })).status).toBe(
      401,
    );
  });

  it('one-click unsubscribe turns email off for that event only; GET only redirects', async () => {
    useFakes();
    const u = await seedUser();
    const t = unsubscribeToken(u.uid, 'mentioned');
    const g = await request(`/hooks/email/unsubscribe?t=${t}`);
    expect(g.status).toBe(302);
    const p = await request(`/hooks/email/unsubscribe?t=${t}`, {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
    });
    expect(p.status).toBe(200);
    const after = (await typedDoc('users', paths.user(u.uid)).get()).data()!;
    expect(after.notify.channels.mentioned).toEqual(['inApp', 'push']);
    expect(after.notify.channels.assigned).toEqual(defaultChannelMatrix().assigned);
    const bad = await request(`/hooks/email/unsubscribe?t=${t}x`, { method: 'POST' });
    expect(bad.status).toBe(400);
  });
});

// ─── WhatsApp ────────────────────────────────────────────────────────────────

const waBody = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value }] }],
});
const outcomes = (r: { body: unknown }) =>
  (r.body as { outcomes: { kind: string; reason?: string }[] }).outcomes;

async function linked(opts: { context?: boolean } = {}) {
  const f = useFakes();
  const number = `+9199${Math.floor(1e7 + Math.random() * 9e7)}`;
  const u = await seedUser({ whatsapp: { number, verifiedAt: T - 1000, optIn: true } });
  const board = await seedBoard([u.uid]);
  const t = await seedTicket(board.id);
  await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:assigned`)).set({
    ...fixtures.inbox,
    event: 'assigned',
    boardId: board.id,
    ticketId: t.id,
    ticketKey: t.key,
    ticketTitle: t.title,
    groupKey: `${t.id}:assigned`,
  });
  await typedDoc('whatsappSessions', paths.whatsappSession(number)).set({
    uid: u.uid,
    lastInboundAt: null,
    contextTicketId: opts.context === false ? null : t.id,
    contextExpiresAt: T + 1000,
  });
  return { f, number, u, board, t, from: number.slice(1) };
}

describe('/hooks/whatsapp', () => {
  it('GET verifies the subscription with the verify token', async () => {
    const ok = await request(
      '/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=42',
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toBe(42);
    const no = await request(
      '/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42',
    );
    expect(no.status).toBe(403);
  });

  it('statuses update deliveries forward only; failed carries the error', async () => {
    useFakes();
    const wamid = `wamid.${uniq()}`;
    const id = uniq('d');
    const row: Delivery = {
      uid: 'u1',
      channel: 'whatsapp',
      groupKey: 'g',
      inboxIds: [],
      status: 'sent',
      provider: 'meta',
      providerId: wamid,
      error: null,
      createdAt: T,
    };
    await typedDoc('deliveries', paths.delivery(id)).set(row);
    const status = async (s: string, extra = {}) =>
      post('/hooks/whatsapp', waBody({ statuses: [{ id: wamid, status: s, ...extra }] }));
    await status('read');
    expect((await typedDoc('deliveries', paths.delivery(id)).get()).data()!.status).toBe('read');
    const late = await status('delivered');
    expect(outcomes(late)[0]).toMatchObject({ kind: 'status', updated: 0 });
    await status('failed', { errors: [{ title: 'Re-engagement message' }] });
    expect((await typedDoc('deliveries', paths.delivery(id)).get()).data()).toMatchObject({
      status: 'failed',
      error: 'Re-engagement message',
    });
  });

  it('a text reply posts to the context ticket via whatsapp and opens the 24h window', async () => {
    const { number, u, board, t, from } = await linked();
    observeCommands();
    const r = await post(
      '/hooks/whatsapp',
      waBody({ messages: [{ id: 'wamid.in1', from, type: 'text', text: { body: 'On it' } }] }),
    );
    expect(outcomes(r)).toEqual([{ kind: 'comment', uid: u.uid, ticketId: t.id }]);
    expect(calls[0]).toMatchObject({
      name: 'messagePost',
      input: { boardId: board.id, ticketId: t.id, clientId: clientIdFrom('wa', 'wamid.in1') },
      ctx: { actor: u.uid, via: 'whatsapp' },
    });
    expect(JSON.stringify(calls[0]!.input.body)).toContain('On it');
    expect(
      (await typedDoc('whatsappSessions', paths.whatsappSession(number)).get()).data()!
        .lastInboundAt,
    ).toBe(T);
  });

  it("Mark done moves to the first done stage; Snooze snoozes the ticket's rows a day", async () => {
    const { f, u, board, t, from } = await linked();
    observeCommands();
    const r = await post(
      '/hooks/whatsapp',
      waBody({
        messages: [
          {
            id: 'wamid.b1',
            from,
            type: 'button',
            button: { text: 'Mark done', payload: 'Mark done' },
          },
        ],
      }),
    );
    expect(outcomes(r)[0]).toMatchObject({ kind: 'done', ticketId: t.id });
    expect(calls[0]).toMatchObject({
      name: 'ticketUpdate',
      input: { boardId: board.id, ticketId: t.id, patch: { stageId: 'st_done' } },
    });
    expect(f.wa.at(-1)).toMatchObject({ kind: 'text', text: `Done: ${t.key} moved to Done.` });

    const r2 = await post(
      '/hooks/whatsapp',
      waBody({
        messages: [
          {
            id: 'wamid.b2',
            from,
            type: 'interactive',
            interactive: { button_reply: { id: 'snooze_1d', title: 'Snooze 1d' } },
          },
        ],
      }),
    );
    expect(outcomes(r2)[0]).toMatchObject({ kind: 'snooze' });
    const row = (await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:assigned`)).get()).data()!;
    expect(row.snoozedUntil).toBe(T + 24 * 3_600_000);
  });

  it('no context → the last notified tickets as a list; a reply to our message finds its ticket', async () => {
    const { f, u, t, from } = await linked({ context: false });
    observeCommands();
    const r = await post(
      '/hooks/whatsapp',
      waBody({ messages: [{ id: 'wamid.x', from, type: 'text', text: { body: 'hello?' } }] }),
    );
    expect(outcomes(r)[0]).toMatchObject({ kind: 'list' });
    expect(f.wa.at(-1)!.text).toContain(t.key);
    expect(calls).toHaveLength(0);

    await typedDoc('deliveries', paths.delivery(uniq('d'))).set({
      uid: u.uid,
      channel: 'whatsapp',
      groupKey: `${t.id}:assigned`,
      inboxIds: [`${t.id}:assigned`],
      status: 'sent',
      provider: 'meta',
      providerId: 'wamid.ours1',
      error: null,
      createdAt: T,
    });
    const r2 = await post(
      '/hooks/whatsapp',
      waBody({
        messages: [
          {
            id: 'wamid.y',
            from,
            type: 'text',
            text: { body: 'yes' },
            context: { id: 'wamid.ours1' },
          },
        ],
      }),
    );
    expect(outcomes(r2)[0]).toMatchObject({ kind: 'comment', ticketId: t.id });
  });

  it('STOP opts out; unknown numbers are ignored; signature enforced when a secret is set', async () => {
    const { f, u, from } = await linked();
    const r = await post(
      '/hooks/whatsapp',
      waBody({ messages: [{ id: 'wamid.s', from, type: 'text', text: { body: ' stop ' } }] }),
    );
    expect(outcomes(r)[0]).toMatchObject({ kind: 'stop' });
    expect((await typedDoc('users', paths.user(u.uid)).get()).data()!.whatsapp!.optIn).toBe(false);
    expect(f.wa.at(-1)!.text).toMatch(/won't get/);

    const r2 = await post(
      '/hooks/whatsapp',
      waBody({
        messages: [{ id: 'wamid.z', from: '10000000000', type: 'text', text: { body: 'hi' } }],
      }),
    );
    expect(outcomes(r2)[0]).toMatchObject({ kind: 'ignored', reason: 'unknown number' });

    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    const body = JSON.stringify(waBody({}));
    expect((await request('/hooks/whatsapp', { method: 'POST', body })).status).toBe(401);
    const ok = await request('/hooks/whatsapp', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': signMeta(body, 'app-secret') },
    });
    expect(ok.status).toBe(200);
  });
});

// ─── whatsappLink ────────────────────────────────────────────────────────────

describe('whatsappLink', () => {
  const lastCode = (f: ReturnType<typeof useFakes>) =>
    f.wa.filter((w) => w.template === 'otp').at(-1)!.params![0]!;

  it('send → verify links the number, opts in, and takes the number from its previous owner', async () => {
    const f = useFakes();
    const number = `+9198${Math.floor(1e7 + Math.random() * 9e7)}`;
    const prevAuth = await createUser();
    await seedUser({ uid: prevAuth.uid, whatsapp: { number, verifiedAt: T - 5000, optIn: true } });
    await typedDoc('whatsappSessions', paths.whatsappSession(number)).set({
      uid: prevAuth.uid,
      lastInboundAt: T - 10,
      contextTicketId: null,
      contextExpiresAt: T,
    });
    const me = await createUser();
    await seedUser({ uid: me.uid });

    await expect(call(me, 'whatsappLink', { step: 'send', number })).resolves.toEqual({ ok: true });
    const code = lastCode(f);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(call(me, 'whatsappLink', { step: 'verify', code: wrong })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(call(me, 'whatsappLink', { step: 'verify', code })).resolves.toEqual({ ok: true });

    expect((await typedDoc('users', paths.user(me.uid)).get()).data()!.whatsapp).toEqual({
      number,
      verifiedAt: T,
      optIn: true,
    });
    expect((await typedDoc('users', paths.user(prevAuth.uid)).get()).data()!.whatsapp).toBeNull();
    expect(
      (await typedDoc('whatsappSessions', paths.whatsappSession(number)).get()).data(),
    ).toMatchObject({
      uid: me.uid,
      lastInboundAt: null,
    });
    // The code is single-use.
    await expect(call(me, 'whatsappLink', { step: 'verify', code })).rejects.toMatchObject({
      code: 'gone',
    });
  });

  it('expired codes and 5 wrong attempts are gone; the 6th send in an hour is rate limited', async () => {
    const f = useFakes();
    const me = await createUser();
    await seedUser({ uid: me.uid });
    const number = `+9197${Math.floor(1e7 + Math.random() * 9e7)}`;
    await call(me, 'whatsappLink', { step: 'send', number });
    f.clock.advance(11 * 60_000);
    await expect(
      call(me, 'whatsappLink', { step: 'verify', code: lastCode(f) }),
    ).rejects.toMatchObject({ code: 'gone' });

    await call(me, 'whatsappLink', { step: 'send', number });
    const code = lastCode(f);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(call(me, 'whatsappLink', { step: 'verify', code: wrong })).rejects.toMatchObject(
        { code: 'invalid' },
      );
    }
    await expect(call(me, 'whatsappLink', { step: 'verify', code })).rejects.toMatchObject({
      code: 'gone',
    });

    await call(me, 'whatsappLink', { step: 'send', number });
    await call(me, 'whatsappLink', { step: 'send', number });
    await call(me, 'whatsappLink', { step: 'send', number });
    await expect(call(me, 'whatsappLink', { step: 'send', number })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });
});
