/**
 * What the file cards and the viewer need to know about a file. Both a
 * message's Attachment and a ticket's files/{fileId} row fit (the attachment
 * id IS the files/ doc id — backend tickets/writes.ts).
 */
import type { Attachment } from '@tm/shared';

export type ViewerFile = Pick<Attachment, 'id' | 'path' | 'name' | 'mime' | 'size'> &
  Partial<Pick<Attachment, 'thumbPath' | 'uploadedBy' | 'width' | 'height'>> & {
    createdAt?: number;
    /** The message it was posted in (Files 'jump to'). */
    messageId?: string | null;
  };
