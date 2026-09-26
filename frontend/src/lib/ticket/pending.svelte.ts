/**
 * Messages through the outbox, the way chat apps do it (agents.html § K):
 * the composer clears on send and a bubble appears at once with a status
 * mark — 🕓 sending, ✓ sent, ! failed. The outbox entry IS the bubble: its id
 * is messagePost's clientId, which the server uses as the message id, so when
 * the thread listener delivers the stored message it takes the bubble's place
 * under the same key (no flicker) and a retry is still ONE message.
 *
 * Entries are persisted (the draft carries everything the bubble needs), so an
 * unsent message survives a reload and is resent on the next visit.
 *
 * Attachments may still be uploading when Send is pressed: the entry carries
 * their progress (shown inside the bubble) and waits for them before posting.
 */
import { AppError, type Message, type Question, type RichTextDoc } from '@tm/shared';
import { outbox, type OutboxEntry, type OutboxStatus, type OutboxUpload } from '$lib/api';
import type { DraftAttachment, UploadItem } from '$lib/editor';
import { routes } from '$lib/layout/routes';

export interface PendingMsg {
  id: string;
  ticketId: string;
  boardId: string;
  /** Phase 5 (§N1): a question a person asked is a bubble too, until it lands. */
  kind: 'comment' | 'question';
  authorUid: string;
  authorName: string;
  createdAt: number;
  body: RichTextDoc;
  replyTo: string | null;
  attachments: DraftAttachment[];
  uploads: OutboxUpload[];
  status: OutboxStatus;
  error?: string;
  /** The form card, while the ask is still in the outbox. */
  question?: Question | null;
}

/** A row in the thread: a stored message or an optimistic bubble. */
export type ThreadItem =
  (Message & { id: string; pending?: undefined }) | (PendingMsg & { pending: true });

/** What a message entry keeps in its draft. */
export interface MessageDraft {
  authorUid: string;
  authorName: string;
  body: RichTextDoc;
  replyTo: string | null;
  attachments: DraftAttachment[];
  ticketKey?: string;
  /** Set on a queued questionAsk: the card the bubble draws (§N1). */
  question?: Question | null;
}

export function pendingOf(e: OutboxEntry): PendingMsg {
  const d = (e.draft ?? {}) as Partial<MessageDraft>;
  return {
    id: e.id,
    ticketId: e.ticketId ?? '',
    boardId: e.boardId ?? '',
    kind: e.command === 'questionAsk' ? 'question' : 'comment',
    authorUid: d.authorUid ?? e.uid,
    authorName: d.authorName ?? 'You',
    createdAt: e.createdAt,
    body: d.body ?? { type: 'doc', content: [] },
    replyTo: d.replyTo ?? null,
    attachments: d.attachments ?? [],
    uploads: (e.uploads ?? []).filter(
      (u) => u.status !== 'done' || !(d.attachments ?? []).some((a) => a.path === u.path),
    ),
    status: e.status,
    error: e.error,
    question: d.question ?? null,
  };
}

/** Bubbles of one ticket, oldest first. */
export function pendingFor(ticketId: string): PendingMsg[] {
  return outbox.messages(ticketId).map(pendingOf);
}

// ——— uploads handed from the composer to a queued message
/* Bookkeeping only, never rendered: plain Maps on purpose. */
/** upload id → message entry id */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const relay = new Map<string, string>();
/** message entry id → wake its prepare() when an upload settles */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const waiters = new Map<string, () => void>();

const toOutboxUpload = (u: UploadItem): OutboxUpload => ({
  id: u.id,
  name: u.name,
  size: u.size,
  mime: u.mime,
  path: u.path,
  progress: u.progress,
  status: u.status,
  ...(u.error ? { error: u.error } : {}),
});

/**
 * The composer's upload callback: when the upload now belongs to a sent
 * message, update that bubble and return true (the composer ignores it).
 */
export function relayUpload(u: UploadItem): boolean {
  const entryId = relay.get(u.id);
  if (!entryId) return false;
  const e = outbox.get(entryId);
  if (!e) {
    relay.delete(u.id);
    return true;
  }
  outbox.setUploads(
    entryId,
    (e.uploads ?? []).map((x) => (x.id === u.id ? toOutboxUpload(u) : x)),
  );
  if (u.status !== 'uploading') relay.delete(u.id);
  waiters.get(entryId)?.();
  return true;
}

function uploadsSettled(e: OutboxEntry | undefined): boolean {
  return !e?.uploads?.some((u) => u.status === 'uploading');
}

export interface SendInput {
  boardId: string;
  ticketId: string;
  ticketKey: string;
  authorUid: string;
  authorName: string;
  body: RichTextDoc;
  replyTo: string | null;
  /** Finished uploads. */
  attachments: DraftAttachment[];
  /** Uploads still in flight: the message waits for them. */
  uploading?: UploadItem[];
}

/** Queue a message. Returns its id (= the bubble's and the stored message's id). */
export function sendMessage(m: SendInput): string {
  const inflight = m.uploading ?? [];
  const draft: MessageDraft = {
    authorUid: m.authorUid,
    authorName: m.authorName,
    body: m.body,
    replyTo: m.replyTo,
    attachments: m.attachments,
    ticketKey: m.ticketKey,
  };
  const input = {
    boardId: m.boardId,
    ticketId: m.ticketId,
    body: m.body,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    ...(m.attachments.length ? { attachments: m.attachments.map((a) => a.path) } : {}),
  };
  const { id } = outbox.queue('messagePost', input, {
    kind: 'message',
    label: 'send your message',
    draft,
    persist: true,
    boardId: m.boardId,
    ticketId: m.ticketId,
    uploads: [
      ...m.attachments.map((a, i) => ({
        id: `done${i}`,
        ...a,
        progress: 1,
        status: 'done' as const,
      })),
      ...inflight.map(toOutboxUpload),
    ],
    // Stays as ✓ until the thread listener brings the stored copy (same id).
    linger: 30_000,
    prepare: inflight.length
      ? async (entry) => {
          if (!uploadsSettled(entry)) {
            await new Promise<void>((resolve) => {
              waiters.set(entry.id, () => {
                if (uploadsSettled(outbox.get(entry.id))) resolve();
              });
            });
            waiters.delete(entry.id);
          }
          const now = outbox.get(entry.id);
          const bad = now?.uploads?.find((u) => u.status === 'error');
          if (bad) throw new AppError('invalid', `${bad.name} did not upload`);
          const paths = (now?.uploads ?? []).filter((u) => u.status === 'done').map((u) => u.path);
          const attachments = paths.length ? { attachments: paths } : {};
          const d = now?.draft as MessageDraft | undefined;
          if (now && d) {
            const all = (now.uploads ?? []).filter((u) => u.status === 'done');
            outbox.setUploads(entry.id, all);
            // The draft now lists every attachment (a reload resends them all).
            outbox.setDraft(entry.id, {
              ...d,
              attachments: all.map(({ path, name, size, mime }) => ({ path, name, size, mime })),
            });
          }
          return { ...input, ...attachments };
        }
      : undefined,
    openTo: routes.ticket(m.ticketKey),
  });
  for (const u of inflight) relay.set(u.id, id);
  return id;
}

// ───────────────────────── asking a question (§N1) ──────────────────────────

export interface AskMsgInput {
  boardId: string;
  ticketId: string;
  ticketKey: string;
  authorUid: string;
  authorName: string;
  /** The card, exactly as the thread will render it (the preview's question). */
  question: Question;
  /** The questionAsk input, minus boardId / ticketId. */
  ask: {
    title: string;
    body: RichTextDoc | null;
    fields: Question['fields'];
    allowComment: boolean;
    to: string[] | null;
    blocking: boolean;
    expiresAt: number | null;
  };
}

/**
 * Ask a question through the outbox, exactly like a message (§N1: 'Ask posts
 * it through the outbox like any message'). The entry id is questionAsk's
 * clientId, which the server uses as the message id — so the optimistic card
 * and the stored one share a key, a retry asks once, and a refusal rolls the
 * card back off the thread.
 */
export function askQuestion(a: AskMsgInput): string {
  const draft: MessageDraft = {
    authorUid: a.authorUid,
    authorName: a.authorName,
    body: { type: 'doc', content: [] },
    replyTo: null,
    attachments: [],
    ticketKey: a.ticketKey,
    question: a.question,
  };
  const { id } = outbox.queue(
    'questionAsk',
    {
      boardId: a.boardId,
      ticketId: a.ticketId,
      title: a.ask.title,
      ...(a.ask.body ? { body: a.ask.body } : {}),
      fields: a.ask.fields,
      allowComment: a.ask.allowComment,
      to: a.ask.to,
      blocking: a.ask.blocking,
      expiresAt: a.ask.expiresAt,
    },
    {
      // 'message' puts it in the thread as a bubble, like any unsent message.
      kind: 'message',
      label: `ask “${a.ask.title}”`,
      draft,
      persist: true,
      boardId: a.boardId,
      ticketId: a.ticketId,
      linger: 30_000,
      openTo: routes.ticket(a.ticketKey),
    },
  );
  return id;
}
