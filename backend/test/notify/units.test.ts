/** The pure parts of notify — no emulator needed. */
import { describe, expect, it } from 'vitest';
import { defaultChannelMatrix } from '@tm/shared';
import {
  clientIdFrom,
  htmlToText,
  parseAddress,
  parseAddressList,
  safeFileName,
  signMeta,
  signSvix,
  stripQuoted,
  verifyMetaSignature,
  verifySvix,
} from '../../src/notify/inbound.js';
import { parseInbound } from '../../src/notify/emailInbound.js';
import { parseWebhook } from '../../src/notify/whatsappInbound.js';
import { candidates, prefAllows, type RecipientTicket } from '../../src/notify/recipients.js';
import { outChannels, windowDelaySeconds } from '../../src/notify/router.js';
import { joinWords, snippet, summarize } from '../../src/notify/summary.js';
import {
  parseReplyAddress,
  phantomRootId,
  replyAddress,
  replyToken,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from '../../src/notify/tokens.js';
import { renderNotifyMail } from '../../src/templates/email.js';
import { renderDigestMail } from '../../src/templates/digest.js';

const ticket: RecipientTicket = {
  id: 't1',
  stageId: 's_rev',
  assigneeUids: ['asg'],
  watcherUids: ['wat'],
  createdBy: 'crt',
};

describe('candidates()', () => {
  const readers = ['actor', 'asg', 'wat', 'crt', 'other'];
  it('board-wide events go to every reader but the actor', () => {
    expect(candidates({ event: 'comment', actor: 'actor', ticket, readers })).toEqual([
      'asg',
      'wat',
      'crt',
      'other',
    ]);
  });
  it('explicit recipients replace the board; non-readers and excluded dropped; deduped', () => {
    expect(
      candidates({
        event: 'assigned',
        actor: 'actor',
        ticket,
        readers,
        recipients: ['asg', 'asg', 'stranger', 'actor', 'wat'],
        exclude: ['wat'],
      }),
    ).toEqual(['asg']);
  });
  it('mentioned uses the mentioned list; deadline events never broadcast', () => {
    expect(
      candidates({ event: 'mentioned', actor: 'actor', ticket, readers, mentioned: ['other'] }),
    ).toEqual(['other']);
    expect(candidates({ event: 'dueSoon', actor: 'system', ticket, readers })).toEqual([]);
  });
  it('invited reaches people who are not readers yet', () => {
    expect(
      candidates({
        event: 'invited',
        actor: 'actor',
        ticket: null,
        readers,
        recipients: ['newbie'],
      }),
    ).toEqual(['newbie']);
  });
});

describe('prefAllows()', () => {
  it('modes', () => {
    expect(prefAllows('other', 'comment', ticket, { mode: 'all' })).toBe(true);
    expect(prefAllows('other', 'comment', ticket, { mode: 'mine' })).toBe(false);
    for (const u of ['asg', 'wat', 'crt'])
      expect(prefAllows(u, 'comment', ticket, { mode: 'mine' })).toBe(true);
    expect(prefAllows('asg', 'comment', ticket, { mode: 'muted' })).toBe(false);
    expect(prefAllows('other', 'comment', ticket, undefined)).toBe(false); // default = mine
    expect(prefAllows('asg', 'comment', ticket, undefined)).toBe(true);
  });
  it('events and stageIds; watching overrides; mentions and invites are unconditional', () => {
    expect(prefAllows('asg', 'updated', ticket, { mode: 'all', events: ['comment'] })).toBe(false);
    expect(prefAllows('asg', 'stage', ticket, { mode: 'all', stageIds: ['s_done'] })).toBe(false);
    expect(
      prefAllows(
        'asg',
        'stage',
        ticket,
        { mode: 'all', stageIds: ['s_done'] },
        { toStageId: 's_done' },
      ),
    ).toBe(true);
    expect(prefAllows('asg', 'stage', ticket, { mode: 'all', stageIds: [] })).toBe(true);
    expect(
      prefAllows('other', 'updated', ticket, { mode: 'muted', events: [], watching: ['t1'] }),
    ).toBe(true);
    expect(prefAllows('other', 'mentioned', ticket, { mode: 'muted', events: [] })).toBe(true);
    expect(prefAllows('x', 'invited', null, undefined)).toBe(true);
  });
});

describe('router helpers', () => {
  it('outChannels: the matrix minus inApp; WhatsApp needs opt-in, email an address', () => {
    const channels = {
      ...defaultChannelMatrix(),
      comment: ['inApp', 'push', 'email', 'whatsapp'] as const,
    };
    const base = {
      notify: { channels: { ...channels, comment: [...channels.comment] } },
      email: 'a@b.c',
      whatsapp: null,
    };
    expect(outChannels(base as never, 'comment')).toEqual(['push', 'email']);
    expect(
      outChannels(
        { ...base, whatsapp: { number: '+1', verifiedAt: 1, optIn: true } } as never,
        'comment',
      ),
    ).toEqual(['push', 'email', 'whatsapp']);
    expect(outChannels({ ...base, email: '' } as never, 'comment')).toEqual(['push']);
    expect(outChannels(base as never, 'updated')).toEqual([]);
  });
  it('windowDelaySeconds lands just after the minute ends', () => {
    expect(windowDelaySeconds(60_000 * 10)).toBe(62);
    expect(windowDelaySeconds(60_000 * 10 + 59_500)).toBe(3);
  });
});

describe('summaries', () => {
  it('per event', () => {
    expect(summarize({ event: 'comment', messageText: 'hello   world' })).toBe(
      'commented: “hello world”',
    );
    expect(summarize({ event: 'mentioned' })).toBe('mentioned you');
    expect(summarize({ event: 'assigned', direct: true })).toBe('assigned you');
    expect(summarize({ event: 'stage', toStageId: 's', stageName: () => 'QA' })).toBe(
      'moved to QA',
    );
    expect(summarize({ event: 'stage' })).toBe('moved this');
    expect(
      summarize({
        event: 'updated',
        changes: {
          title: { from: 1, to: 2 },
          'fields.x': { from: 1, to: 2 },
          dueAt: { from: 1, to: 2 },
        },
      }),
    ).toBe('changed the title, a field and the due date');
    expect(summarize({ event: 'state', ticketState: 'archived' })).toBe('archived this');
    expect(summarize({ event: 'state', ticketState: 'active' })).toBe('restored this');
    expect(summarize({ event: 'invited', boardName: 'Eng' })).toBe('invited you to Eng');
    expect(summarize({ event: 'overdue' })).toBe('is overdue');
  });
  it('helpers', () => {
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect(snippet('x'.repeat(200), 10)).toBe('xxxxxxxxx…');
  });
});

describe('tokens', () => {
  it('reply tokens are stable, lower-case and round-trip through the address', () => {
    const t = replyToken('u1', 't1');
    expect(t).toBe(replyToken('u1', 't1'));
    expect(t).not.toBe(replyToken('u2', 't1'));
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(parseReplyAddress(replyAddress(t).toUpperCase())).toBe(t);
    expect(parseReplyAddress(`t.${t}@elsewhere.test`)).toBeNull();
    expect(phantomRootId('t1')).toBe('<ticket-t1@taskmanager.app>');
  });
  it('unsubscribe tokens verify and reject tampering', () => {
    const tok = unsubscribeToken('u1', 'comment');
    expect(verifyUnsubscribeToken(tok)).toEqual({ uid: 'u1', event: 'comment' });
    const forged =
      Buffer.from(JSON.stringify({ u: 'u2', e: 'comment' })).toString('base64url') +
      '.' +
      tok.split('.')[1];
    expect(verifyUnsubscribeToken(forged)).toBeNull();
    expect(verifyUnsubscribeToken('garbage')).toBeNull();
  });
});

describe('inbound helpers', () => {
  it('svix and Meta signatures', () => {
    const secret = 'whsec_' + Buffer.from('k').toString('base64');
    const h = signSvix('{"a":1}', secret, 'id1', 1000);
    const get = {
      id: h['svix-id'],
      timestamp: h['svix-timestamp'],
      signature: `v1,bogus ${h['svix-signature']}`,
    };
    expect(verifySvix(get, '{"a":1}', secret, 1000_000)).toBe(true);
    expect(verifySvix(get, '{"a":2}', secret, 1000_000)).toBe(false);
    expect(verifySvix(get, '{"a":1}', secret, 2000_000)).toBe(false);
    expect(verifySvix({}, '{}', secret, 0)).toBe(false);
    expect(verifyMetaSignature(signMeta('body', 's'), 'body', 's')).toBe(true);
    expect(verifyMetaSignature(signMeta('body', 's'), 'body2', 's')).toBe(false);
    expect(verifyMetaSignature(undefined, 'body', 's')).toBe(false);
  });
  it('addresses', () => {
    expect(parseAddress('"Priya S" <Priya@X.com>')).toEqual({
      name: 'Priya S',
      email: 'priya@x.com',
    });
    expect(parseAddress('a@b.co')).toEqual({ name: null, email: 'a@b.co' });
    expect(parseAddress('not an address')).toBeNull();
    expect(parseAddressList('a@b.co, B <b@c.io>').map((a) => a.email)).toEqual([
      'a@b.co',
      'b@c.io',
    ]);
    expect(parseAddressList([{ email: 'x@y.zz' }]).map((a) => a.email)).toEqual(['x@y.zz']);
  });
  it('stripQuoted keeps only what was written', () => {
    expect(
      stripQuoted('Yes!\n\nOn Mon, Sep 21, 2026 at 9:00 AM Priya <p@x.com> wrote:\n> old'),
    ).toBe('Yes!');
    expect(
      stripQuoted('Yes!\nOn Mon, Sep 21, 2026 at 9:00 AM Priya\n<p@x.com> wrote:\n> old'),
    ).toBe('Yes!');
    expect(stripQuoted('Fine\r\n-- \r\nSig')).toBe('Fine');
    expect(stripQuoted('A\n> quoted\nB\n-----Original Message-----\nold')).toBe('A\nB');
    expect(stripQuoted('ok\n\nSent from my iPhone')).toBe('ok');
  });
  it('html, file names, client ids', () => {
    expect(htmlToText('<p>Hi&nbsp;<b>there</b></p><blockquote>old</blockquote><br>x &amp; y')).toBe(
      'Hi there\n\nx & y',
    );
    expect(safeFileName('../../etc/pass wd?.txt')).toBe('pass wd_.txt');
    expect(safeFileName('...')).toBe('file');
    expect(clientIdFrom('em', '<a@b>')).toMatch(/^em_[0-9a-f]{40}$/);
  });
  it('payload parsing', () => {
    expect(
      parseInbound({
        type: 'email.received',
        data: { from: 'a@b.co', to: ['c@d.co'], subject: 's', headers: { 'message-id': '<m>' } },
      }),
    ).toMatchObject({
      from: 'a@b.co',
      to: ['c@d.co'],
      messageId: '<m>',
      attachments: [],
    });
    expect(parseInbound({ from: 'a@b.co' })).toBeNull();
    expect(parseInbound('nope')).toBeNull();
    const wa = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 'w1', status: 'read' }, {}],
                messages: [{ id: 'm', from: '1' }],
              },
            },
          ],
        },
      ],
    });
    expect(wa.statuses).toHaveLength(1);
    expect(wa.messages).toHaveLength(1);
    expect(parseWebhook(null)).toEqual({ statuses: [], messages: [] });
  });
});

describe('templates', () => {
  it('notification mail escapes everything and threads by subject', () => {
    const m = renderNotifyMail({
      event: 'comment',
      actorName: '<Eve>',
      summary: 'commented: “<script>”',
      count: 3,
      ticketKey: 'ENG-1',
      ticketTitle: 'A & B',
      boardName: 'Eng',
      url: 'https://x/t/ENG-1?a="b"',
      settingsUrl: 'https://x/s',
      replyable: true,
    });
    expect(m.subject).toBe('[ENG-1] A & B');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<Eve>');
    expect(m.html).toContain('A &amp; B');
    expect(m.html).toContain('&quot;b&quot;');
    expect(m.text).toContain('<Eve> commented: “<script>” (3 updates)');
    expect(m.text).toContain('Reply to this email');
    const inv = renderNotifyMail({
      event: 'invited',
      actorName: 'Asha',
      summary: 'invited you to Eng',
      count: 1,
      ticketKey: null,
      ticketTitle: null,
      boardName: 'Eng',
      url: 'u',
      settingsUrl: 's',
      replyable: false,
    });
    expect(inv.subject).toBe('Asha invited you to Eng');
    expect(inv.text).not.toContain('Reply to this email');
  });
  it('digest mail', () => {
    const d = renderDigestMail({
      name: 'Dee',
      period: 'hourly',
      boards: [{ name: 'B<1>', items: [{ line: 'x', url: 'u' }] }],
      dueToday: [],
      overdue: [{ key: 'K-1', title: 't', url: 'u' }],
      inboxUrl: 'i',
      settingsUrl: 's',
    });
    expect(d.subject).toBe('Your hourly digest: 1 unread, 1 overdue');
    expect(d.html).toContain('B&lt;1&gt;');
  });
});
