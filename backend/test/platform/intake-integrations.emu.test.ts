/**
 * Intake (the website widget), the GitHub hook, install connect (stubbed
 * OAuth) and the ICS feed.
 */
import { describe, expect, it } from 'vitest';
import { paths, type Integration, type MemoryNode, type Message, type Ticket } from '@tm/shared';
import { DEV_GITHUB_SECRET, findKeys } from '../../src/doors/hooks/github.js';
import { hmacHex } from '../../src/platform/crypto.js';
import { verifyState } from '../../src/platform/integrations.js';
import { db } from '../../src/runtime/firebase.js';
import { call, devOutbox, request, setupEmulators } from '../harness/index.js';
import { people, seedAttachMemory, seedBoard, STAGES } from '../tickets/helpers.js';
import { msgsOf } from '../tickets/store.js';

setupEmulators();

const intakeHeaders = (slug: string, secret: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-tm-intake': slug,
  'x-tm-secret': secret,
  ...extra,
});

describe('intake', () => {
  it('intakeUpsert: admin only, secret shown once; the widget posts a ticket with mapped fields', async () => {
    const { admin, ed } = await people('admin', 'ed');
    const b = await seedBoard({ admin, editors: [ed] });
    expect(await call(admin, 'intakeUpsert', { boardId: b.id })).toEqual({ intake: null });
    await expect(call(ed, 'intakeUpsert', { boardId: b.id, enabled: true })).rejects.toMatchObject({
      code: 'forbidden',
    });

    const made = await call(admin, 'intakeUpsert', {
      boardId: b.id,
      enabled: true,
      allowedOrigins: ['https://shop.example.com'],
      defaults: { priorityId: 'p_high', tagIds: ['tg_bug'] },
      fieldMap: { points: 'f_points' },
    });
    expect(made.secret).toMatch(/^tmi_/);
    const slug = made.intake!.slug;
    expect(JSON.stringify(made.intake)).not.toContain('secretHash');
    const read = await call(admin, 'intakeUpsert', { boardId: b.id });
    expect(read.secret).toBeUndefined();
    expect(read.intake!.slug).toBe(slug);

    const bad = await request('/v1/intake', {
      method: 'POST',
      headers: intakeHeaders(slug, 'tmi_wrong'),
      body: JSON.stringify({ title: 'x' }),
    });
    expect(bad.status).toBe(401);
    const origin = await request('/v1/intake', {
      method: 'POST',
      headers: intakeHeaders(slug, made.secret!, { origin: 'https://evil.example.com' }),
      body: JSON.stringify({ title: 'x' }),
    });
    expect(origin.status).toBe(403);

    // memory.html §J: the widget's files go into the board's attachment memory.
    const memoryId = await seedAttachMemory(b.id, admin);
    const ok = await request('/v1/intake', {
      method: 'POST',
      headers: intakeHeaders(slug, made.secret!, { origin: 'https://shop.example.com' }),
      body: JSON.stringify({
        title: 'Checkout button does nothing',
        description: 'Clicked twice.',
        reporter: { email: 'customer@example.org', name: 'Cara' },
        meta: { points: '3', page: 'https://shop.example.com/cart' },
        attachments: [{ name: 'shot.txt', contentBase64: Buffer.from('hello').toString('base64') }],
      }),
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    const res = ok.body as { id: string; key: string };
    expect(res.key).toBe(`${b.key}-1`);
    const t = (await db().doc(paths.ticket(b.id, res.id)).get()).data() as Ticket;
    expect(t).toMatchObject({
      createdVia: 'intake',
      priorityId: 'p_high',
      tagIds: ['tg_bug'],
      fields: { f_points: 3 },
    });
    expect(t.description!.text).toContain('Reported by Cara (customer@example.org)');
    expect(t.description!.text).toContain('https://shop.example.com/cart');
    expect(t.counts.files).toBe(1);
    const row = (t.files ?? [])[0]!;
    expect(row).toMatchObject({ source: 'memory', memory: { memoryId } });
    const node = (
      await db().doc(paths.memoryNode(memoryId, row.memory!.nodeId)).get()
    ).data() as MemoryNode;
    // '<ticketId>' became the new key.
    expect(node.path).toMatch(new RegExp(`^tickets/${res.key}/\\d{8}-\\d{6}_shot\\.txt$`));
    expect(node.createdBy).toBe('intake-bot');
    const receipts = await devOutbox<{ subject: string }>('mail', {
      field: 'to',
      equals: 'customer@example.org',
    });
    expect(receipts.some((m) => m.subject.includes(res.key))).toBe(true);

    const schema = await request('/v1/intake/schema', {
      headers: intakeHeaders(slug, made.secret!),
    });
    expect(schema.body).toMatchObject({
      board: { key: b.key },
      priorities: [{ name: 'High' }, { name: 'Low' }],
    });

    // Rotation: the old secret stops working at once.
    const rot = await call(admin, 'intakeUpsert', { boardId: b.id, rotateSecret: true });
    const old = await request('/v1/intake/schema', { headers: intakeHeaders(slug, made.secret!) });
    expect(old.status).toBe(401);
    expect(
      (await request('/v1/intake/schema', { headers: intakeHeaders(slug, rot.secret!) })).status,
    ).toBe(200);
  });

  it('a board with no attachment memory takes the report without its files, and says so', async () => {
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    const made = await call(admin, 'intakeUpsert', { boardId: b.id, enabled: true });
    const ok = await request('/v1/intake', {
      method: 'POST',
      headers: intakeHeaders(made.intake!.slug, made.secret!),
      body: JSON.stringify({
        title: 'No memory here',
        attachments: [{ name: 'shot.txt', contentBase64: Buffer.from('x').toString('base64') }],
      }),
    });
    expect(ok.status).toBe(201);
    const t = (
      await db()
        .doc(paths.ticket(b.id, (ok.body as { id: string }).id))
        .get()
    ).data() as Ticket;
    expect(t.counts.files).toBe(0);
    expect(t.description!.text).toContain('1 attachment was not saved');
  });

  it('rate limits per intake — when limits are switched on (§X: off by default)', async () => {
    // Phase 16: this app is private and runs with no rate limits at all; the
    // limiter is kept whole for the day it is not, so the test asks for it.
    process.env.TM_RATE_LIMITS = '1';
    const { admin } = await people('admin');
    const b = await seedBoard({ admin });
    const made = await call(admin, 'intakeUpsert', { boardId: b.id, enabled: true });
    await db()
      .doc(paths.intake(made.intake!.slug))
      .update({ limits: { perMin: 1, perHour: 10, perDay: 10 } });
    const h = intakeHeaders(made.intake!.slug, made.secret!);
    expect((await request('/v1/intake/schema', { headers: h })).status).toBe(200);
    const r = await request('/v1/intake/schema', { headers: h });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    delete process.env.TM_RATE_LIMITS;
  });
});

// ─── GitHub ──────────────────────────────────────────────────────────────────

function github(event: string, payload: unknown, delivery: string, secret = DEV_GITHUB_SECRET) {
  const body = JSON.stringify(payload);
  return request('/hooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${hmacHex(secret, body)}`,
    },
    body,
  });
}

describe('install connect (stubbed OAuth) and the GitHub hook', () => {
  it('finds keys the way the spec says', () => {
    expect(findKeys('eng-42-login-redirect', 'ENG-7 and OPS-12 fix', null)).toEqual([
      'ENG-42',
      'ENG-7',
      'OPS-12',
    ]);
  });

  it('connect → callback writes the integration; PR opened posts a line; merge moves the ticket', async () => {
    const { admin, ed } = await people('admin', 'ed');
    const b = await seedBoard({ admin, editors: [ed] });

    const denied = await request('/integrations/github/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ed.token}` },
      body: JSON.stringify({ boardId: b.id }),
    });
    expect(denied.status).toBe(403);
    const conn = await request('/integrations/github/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ boardId: b.id }),
    });
    expect(conn.status).toBe(200);
    const url = new URL((conn.body as { url: string }).url);
    expect(url.pathname).toBe('/integrations/github/callback');
    expect(verifyState(url.searchParams.get('state')!, Date.now())).toMatchObject({
      uid: admin.uid,
      boardId: b.id,
    });
    // A tampered state is refused.
    const forged = await request(
      `/integrations/github/callback?state=${url.searchParams.get('state')!.slice(0, -2)}xx&code=c`,
    );
    expect(forged.status).toBe(403);
    url.searchParams.set('repos', 'acme/web');
    url.searchParams.set('moveOnMerge', STAGES.review);
    const cb = await request(`${url.pathname}?${url.searchParams}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    const integ = (await db().doc(paths.integration(b.id, 'github')).get()).data() as Integration;
    expect(integ).toMatchObject({
      status: 'active',
      connectedBy: admin.uid,
      config: { repos: [{ fullName: 'acme/web', moveOnMerge: STAGES.review }] },
    });

    const t = await call(admin, 'ticketCreate', { boardId: b.id, title: 'Login redirect' });
    const pr = (action: string, merged = false) => ({
      action,
      repository: { full_name: 'acme/web' },
      sender: { login: 'octocat' },
      pull_request: {
        number: 812,
        title: `${t.key} fix redirect`,
        html_url: 'https://github.com/acme/web/pull/812',
        head: { ref: `${t.key.toLowerCase()}-login-redirect` },
        user: { login: 'octocat' },
        merged,
        merged_by: merged ? { login: 'hubot' } : null,
      },
    });

    const bad = await github('pull_request', pr('opened'), 'd0', 'wrong-secret');
    expect(bad.status).toBe(401);
    const opened = await github('pull_request', pr('opened'), 'd1');
    expect(opened.body).toMatchObject({ touched: [t.key] });
    // Redelivery is not a second line.
    await github('pull_request', pr('opened'), 'd1');
    let msgs = (await msgsOf(b.id, t.ticketId)) as Message[];
    const lines = msgs.filter((m) => m.kind === 'system' && m.body.text.includes('PR #812'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ via: 'integration', authorName: 'GitHub' });
    expect(lines[0]!.body.text).toContain('opened by octocat');

    // An unlinked repo is ignored.
    const other = await github(
      'pull_request',
      { ...pr('opened'), repository: { full_name: 'someone/else' } },
      'd2',
    );
    expect(other.body).toMatchObject({ touched: [] });

    await github('pull_request', pr('closed', true), 'd3');
    const after = (await db().doc(paths.ticket(b.id, t.ticketId)).get()).data() as Ticket;
    expect(after.stageId).toBe(STAGES.review);
    msgs = (await msgsOf(b.id, t.ticketId)) as Message[];
    expect(msgs.some((m) => m.body.text.includes('merged by hubot'))).toBe(true);

    const pushed = await github(
      'push',
      {
        ref: 'refs/heads/main',
        repository: { full_name: 'acme/web' },
        pusher: { name: 'octo' },
        compare: 'https://github.com/acme/web/compare/a...b',
        commits: [{ message: `${t.key}: tidy up\n\nmore` }],
      },
      'd4',
    );
    expect(pushed.body).toMatchObject({ touched: [t.key] });

    // installRemove.
    await call(admin, 'installRemove', { boardId: b.id, provider: 'github' });
    expect(
      ((await db().doc(paths.integration(b.id, 'github')).get()).data() as Integration).status,
    ).toBe('removed');
    const ignored = await github('pull_request', pr('reopened'), 'd5');
    expect(ignored.body).toMatchObject({ touched: [] });
  });
});

// ─── ICS ─────────────────────────────────────────────────────────────────────

describe('icsFeed', () => {
  it('serves my due tickets; a rotated URL stops working', async () => {
    const { u, v } = await people('u', 'v');
    const b = await seedBoard({ admin: u, editors: [v] });
    const due = Date.UTC(2030, 0, 2, 9, 30);
    await call(u, 'ticketCreate', {
      boardId: b.id,
      title: 'Timed, mine',
      assigneeUids: [u.uid],
      dueAt: due,
      dueAllDay: false,
    });
    await call(u, 'ticketCreate', {
      boardId: b.id,
      title: 'All day, mine',
      assigneeUids: [u.uid],
      dueAt: Date.UTC(2030, 0, 5),
      dueAllDay: true,
    });
    await call(u, 'ticketCreate', { boardId: b.id, title: 'No due, mine', assigneeUids: [u.uid] });
    await call(u, 'ticketCreate', {
      boardId: b.id,
      title: 'Someone else',
      assigneeUids: [v.uid],
      dueAt: due,
    });

    const { path } = (await call(u, 'icsFeedUrl', {})) as { path: string };
    const r = await request(path);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/calendar');
    const ics = String(r.body);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20300102T093000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20300105');
    expect(ics).toContain('Timed\\, mine');
    expect(ics).not.toContain('Someone else');

    expect(
      (
        await request(
          path.replace(/\.[A-Za-z0-9_-]{32}\.ics$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics'),
        )
      ).status,
    ).toBe(404);
    const { path: rotated } = (await call(u, 'icsFeedUrl', { rotate: true })) as { path: string };
    expect(rotated).not.toBe(path);
    expect((await request(path)).status).toBe(404);
    expect((await request(rotated)).status).toBe(200);
  });
});
