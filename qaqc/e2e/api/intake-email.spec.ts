/**
 * Flows: "A bug reported from a website" (intake widget → ticket) and the
 * e-mail half of "A conversation on a ticket" (a notification e-mail is
 * answered; the reply lands in the same thread, via email).
 *
 * Inbound mail is faked the way the provider would send it: a POST to
 * /hooks/email (unsigned is accepted only under the emulators). Outbound mail
 * is read from the dev outbox (_dev/mail/items).
 */
import { expect, test } from '@playwright/test';
import {
  call,
  doc,
  eventually,
  messagesOf,
  http,
  inviteAndAccept,
  mailTo,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';

test('intake widget: schema, a post with the slug + secret becomes a ticket; wrong secret / origin refused', async () => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { template: 'bugs', name: 'Website bugs' });
  const { intake, secret } = await call(ada, 'intakeUpsert', {
    boardId: b.id,
    enabled: true,
    allowedOrigins: ['https://shop.example.com'],
    defaults: { stageId: stage(b, 'Triage') },
  });
  expect(intake?.slug).toBeTruthy();
  expect(secret).toBeTruthy();
  const headers = {
    'content-type': 'application/json',
    'x-tm-intake': intake!.slug,
    'x-tm-secret': secret!,
  };

  const schema = await http('/v1/intake/schema', { headers });
  expect(schema.status, JSON.stringify(schema.body)).toBe(200);
  expect(schema.body.board.key).toBe(b.key);

  const post = await http('/v1/intake', {
    method: 'POST',
    headers: { ...headers, origin: 'https://shop.example.com' },
    body: JSON.stringify({
      title: 'Checkout button does nothing',
      description: 'Clicked it **twice**.',
      reporter: { email: 'shopper@example.com', name: 'A Shopper' },
      meta: { page: 'https://shop.example.com/cart', ua: 'e2e' },
      attachments: [
        { name: 'note.txt', contentBase64: Buffer.from('console: TypeError').toString('base64') },
      ],
    }),
  });
  expect(post.status, JSON.stringify(post.body)).toBe(201);
  expect(post.body.key).toBe(`${b.key}-1`);
  const t = await read(`boards/${b.id}/tickets/${post.body.id}`);
  expect(t).toMatchObject({ title: 'Checkout button does nothing', stageId: stage(b, 'Triage') });
  expect(JSON.stringify(t?.description)).toContain('shopper@example.com');
  // made by the intake actor (on no board), with the reporter stored
  expect(t).toMatchObject({
    createdBy: 'intake-bot',
    createdVia: 'intake',
    reporter: { uid: null, email: 'shopper@example.com', name: 'A Shopper' },
  });

  const wrongSecret = await http('/v1/intake', {
    method: 'POST',
    headers: { ...headers, 'x-tm-secret': 'nope' },
    body: JSON.stringify({ title: 'x' }),
  });
  expect(wrongSecret.status).toBe(401);
  const wrongOrigin = await http('/v1/intake', {
    method: 'POST',
    headers: { ...headers, origin: 'https://evil.example.net' },
    body: JSON.stringify({ title: 'x' }),
  });
  expect(wrongOrigin.status).toBe(403);
});

test('email reply → thread: a mention mails Grace; her reply lands in the same thread, via email', async () => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const { ticketId, key } = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Decide the release date',
  });
  await call(ada, 'messagePost', {
    boardId: b.id,
    ticketId,
    body: doc([{ mention: grace.uid }, ' can we ship on Friday?']),
    clientId: `e2e-${Date.now()}`,
  });

  const mail = await eventually(
    'the mention e-mail',
    async () => (await mailTo(grace.email)).find((m) => m.replyTo && `${m.subject}`.includes(key)),
    45_000,
  );
  expect(mail.replyTo).toMatch(/^t\./);

  const hook = await http('/hooks/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'email.received',
      data: {
        from: `Grace <${grace.email}>`,
        to: [mail.replyTo],
        subject: `Re: ${mail.subject}`,
        text: 'Friday works for me.\n\nOn Mon, Ada wrote:\n> can we ship on Friday?',
        message_id: `<e2e-${Date.now()}@mail.example.com>`,
      },
    }),
  });
  expect(hook.status, JSON.stringify(hook.body)).toBe(200);

  const reply = await eventually('the reply in the thread', async () => {
    return (await messagesOf(b.id, ticketId)).find(
      (m) => m.authorUid === grace.uid && JSON.stringify(m.body).includes('Friday works'),
    );
  });
  expect(reply.via).toBe('email');
  // quoted history is stripped
  expect(JSON.stringify(reply.body)).not.toContain('can we ship on Friday');

  // a reply from someone else to the same address is dropped
  const spoof = await http('/hooks/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'email.received',
      data: { from: 'mallory@example.com', to: [mail.replyTo], subject: 'Re', text: 'hi' },
    }),
  });
  expect(spoof.status).toBe(200);
  expect(JSON.stringify(spoof.body)).toContain('dropped');
});

test('email-to-board: a mail to the intake address becomes a ticket with the intake defaults', async () => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { template: 'support', name: 'Support desk' });
  const { intake } = await call(ada, 'intakeUpsert', {
    boardId: b.id,
    enabled: true,
    defaults: { stageId: stage(b, 'New') },
  });
  expect(intake?.email).toMatch(/@/);

  const hook = await http('/hooks/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'email.received',
      data: {
        from: 'Carol Customer <carol@example.com>',
        to: [intake!.email],
        subject: 'Cannot download my invoice',
        text: 'The link says 404.',
        message_id: `<e2e-${Date.now()}@example.com>`,
      },
    }),
  });
  expect(hook.status, JSON.stringify(hook.body)).toBe(200);
  expect(hook.body.outcome).toMatchObject({ kind: 'ticket' });
  const t = await read(`boards/${b.id}/tickets/${hook.body.outcome.ticketId}`);
  expect(t).toMatchObject({ title: 'Cannot download my invoice', stageId: stage(b, 'New') });
  expect(t?.reporter).toMatchObject({
    uid: null,
    email: 'carol@example.com',
    name: 'Carol Customer',
  });
});
