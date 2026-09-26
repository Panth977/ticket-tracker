import { describe, expect, it } from 'vitest';
import {
  isUnderTicket,
  parseAgentAvatarPath,
  parseAttachmentPath,
  parseMessagePath,
  parseTicketPath,
  paths,
  rtdb,
  storage,
} from './paths.js';

describe('paths', () => {
  it('builds Firestore paths', () => {
    expect(paths.ticket('b1', 't1')).toBe('boards/b1/tickets/t1');
    expect(paths.message('b1', 't1', 'm1')).toBe('boards/b1/tickets/t1/messages/m1');
    expect(paths.member('b1', 'u1')).toBe('boards/b1/members/u1');
    expect(paths.inboxItem('u1', 'n1')).toBe('users/u1/inbox/n1');
    expect(paths.key('ENG-42')).toBe('keys/ENG-42');
    expect(paths.webhookDelivery('b', 'w', 'd')).toBe('boards/b/webhooks/w/deliveries/d');
    expect(paths.idem('u1', 'c1')).toBe('_idem/u1_c1');
  });

  it('refuses segments that would change the path shape', () => {
    expect(() => paths.ticket('b1/x', 't1')).toThrow();
    expect(() => paths.user('')).toThrow();
    expect(() => paths.user('..')).toThrow();
  });

  it('parses paths back', () => {
    expect(parseTicketPath('boards/b1/tickets/t1')).toEqual({ boardId: 'b1', ticketId: 't1' });
    expect(parseTicketPath('boards/b1/tickets/t1/messages/m')).toBeNull();
    expect(parseMessagePath('boards/b1/tickets/t1/messages/m')).toEqual({
      boardId: 'b1',
      ticketId: 't1',
      messageId: 'm',
    });
  });

  it('builds RTDB and Storage paths', () => {
    expect(rtdb.presence('b', 'u')).toBe('presence/b/u');
    expect(rtdb.typing('b', 't', 'u')).toBe('typing/b/t/u');
    expect(rtdb.boardReader('b', 'u')).toBe('boardReaders/b/u');
    expect(rtdb.rate('key:abc', 123)).toBe('rate/key:abc/123');
    const a = storage.attachment('b', 't', 'a1', 'x.png');
    expect(a).toBe('boards/b/tickets/t/a1/x.png');
    expect(parseAttachmentPath(a)).toEqual({
      boardId: 'b',
      ticketId: 't',
      attachmentId: 'a1',
      fileName: 'x.png',
    });
    expect(parseAttachmentPath(storage.thumb('b', 't', 'a1'))).toBeNull();
    expect(isUnderTicket(a, 'b', 't')).toBe(true);
    expect(isUnderTicket(a, 'b', 'other')).toBe(false);
    expect(storage.avatar('u', 5)).toBe('users/u/avatar/5.webp');
    expect(storage.export('u', 'j')).toBe('exports/u/j.zip');
  });
});

describe('phase-2 paths', () => {
  it('agents, agent inbox, agent avatars', () => {
    const ag = 'ag_Bu1lder000000001';
    expect(paths.agent(ag)).toBe(`agents/${ag}`);
    expect(paths.agentEvents(ag)).toBe(`agentInbox/${ag}/events`);
    expect(paths.agentEvent(ag, 'e1')).toBe(`agentInbox/${ag}/events/e1`);
    const av = storage.agentAvatar('u1', ag, 7);
    expect(av).toBe(`users/u1/agents/${ag}/avatar/7.webp`);
    expect(av.startsWith(storage.agentAvatarPrefix('u1', ag))).toBe(true);
    expect(parseAgentAvatarPath(av)).toEqual({ ownerUid: 'u1', agentId: ag });
    expect(parseAgentAvatarPath(storage.avatar('u1', 7))).toBeNull();
  });
});
