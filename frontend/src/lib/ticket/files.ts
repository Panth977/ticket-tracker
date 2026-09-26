/**
 * Files on the open ticket, for the cards and the viewer: the /f/… address of
 * a file, a 'who · when' line, and a message's attachments as ViewerFiles.
 */
import { fileViewerPath, type Attachment } from '@tm/shared';
import type { ViewerFile } from '$lib/files';
import type { TicketCtx } from './context';
import { formatWhen } from './time';

/** /f/{boardKey}/{ticketKey}/{fileId} — the same viewer as a full page (agents.html §I). */
export const fileHref =
  (t: Pick<TicketCtx, 'board' | 'ticket'>) =>
  (f: ViewerFile): string =>
    fileViewerPath(t.board.key, t.ticket.key, f.id);

/** 'Priya · 2 h ago' for the viewer's header. */
export const fileDescriber =
  (t: Pick<TicketCtx, 'members' | 'tz'>) =>
  (f: ViewerFile): string | null => {
    const who = f.uploadedBy ? (t.members.find((m) => m.uid === f.uploadedBy)?.name ?? null) : null;
    const when = f.createdAt ? formatWhen(f.createdAt, t.tz) : null;
    return [who, when].filter(Boolean).join(' · ') || null;
  };

/** A stored message's attachments as viewer files (the attachment id is the files/ doc id). */
export function attachmentFiles(
  atts: readonly Attachment[],
  messageId: string,
  createdAt: number,
): ViewerFile[] {
  return atts.map((a) => ({ ...a, messageId, createdAt }));
}
