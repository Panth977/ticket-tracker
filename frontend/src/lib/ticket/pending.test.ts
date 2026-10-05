import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from '$lib/api';
import { pendingOf } from './pending.svelte';
import { mergeThread } from './thread';

const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'm1',
  uid: 'u1',
  command: 'messagePost',
  input: { boardId: 'b1', ticketId: 't1' },
  kind: 'message',
  label: 'send your message',
  status: 'sending',
  attempts: 1,
  createdAt: 1000,
  boardId: 'b1',
  ticketId: 't1',
  persist: true,
  draft: {
    authorUid: 'u1',
    authorName: 'Ada',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    },
    replyTo: null,
    attachments: [{ path: 'p/a.png', name: 'a.png', size: 1, mime: 'image/png' }],
  },
  ...over,
});

describe('message bubbles from outbox entries', () => {
  it('maps an entry to a bubble with its status and author', () => {
    const b = pendingOf(entry());
    expect(b).toMatchObject({
      id: 'm1',
      ticketId: 't1',
      authorName: 'Ada',
      status: 'sending',
      replyTo: null,
    });
    expect(b.attachments).toHaveLength(1);
  });

  it('carries the failure reason and upload progress (finished attachments are not repeated)', () => {
    const b = pendingOf(
      entry({
        status: 'failed',
        error: 'Not allowed',
        uploads: [
          {
            id: 'x',
            path: 'p/a.png',
            name: 'a.png',
            size: 1,
            mime: 'image/png',
            progress: 1,
            status: 'done',
          },
          {
            id: 'y',
            path: 'p/b.pdf',
            name: 'b.pdf',
            size: 9,
            mime: 'application/pdf',
            progress: 0.4,
            status: 'uploading',
          },
        ],
      }),
    );
    expect(b.status).toBe('failed');
    expect(b.error).toBe('Not allowed');
    expect(b.uploads.map((u) => u.name)).toEqual(['b.pdf']);
  });

  it('the stored message replaces its bubble (same id: messagePost uses the clientId)', () => {
    const bubble = { ...pendingOf(entry()), pending: true as const };
    const stored = {
      id: 'm1',
      kind: 'comment' as 'comment' | 'question',
      authorUid: 'u1',
      authorName: 'Ada',
      createdAt: 1001,
    };
    const merged = mergeThread<{
      id: string;
      kind: 'comment' | 'question' | 'agg';
      authorUid: string;
      authorName: string;
      createdAt: number;
    }>([stored], [bubble]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(stored);
  });

  it('survives a reload: an entry with no draft still renders', () => {
    const b = pendingOf(entry({ draft: undefined }));
    expect(b.authorUid).toBe('u1');
    expect(b.body).toEqual({ type: 'doc', content: [] });
  });
});

describe('Google Chat grouping', () => {
  it('groups one author within 5 minutes', async () => {
    const { GROUP_GAP_MS } = await import('./thread');
    expect(GROUP_GAP_MS).toBe(5 * 60 * 1000);
  });
});
