/**
 * Attachment uploads: "upload direct, attach through a command" (storage.rules).
 * The browser writes the file straight to
 *   boards/{boardId}/tickets/{ticketId}/{attachmentId}/{fileName}
 * with progress; messagePost later names the path, and the server checks the
 * object exists under this ticket's prefix. An upload never attached is swept
 * after 24 h, so cancelling one needs no cleanup here.
 */
import { ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { MAX_ATTACHMENT_BYTES, storage, THUMB_NAME } from '@tm/shared';
import { getStorageClient } from '$lib/firebase/client';

export type UploadStatus = 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** 0..1 */
  progress: number;
  status: UploadStatus;
  path: string;
  error?: string;
  /** Object URL for an image preview (revoked when removed). */
  preview?: string;
}

/**
 * A Storage-safe file name: no slashes or control characters, not the
 * server's thumbnail name, at most 200 chars (keeping the extension).
 */
export function safeFileName(name: string): string {
  let n = name
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f/\\#?[\]*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n === THUMB_NAME) n = '_' + n;
  if (n.length > 200) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

export function newAttachmentId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 20);
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
}

/** Why a file cannot be attached, or null. */
export function rejectReason(file: { size: number }): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return 'Files are limited to 50 MB';
  if (file.size === 0) return 'The file is empty';
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Start uploading `file` for this ticket. `onChange` is called with the item
 * on every progress tick and when it settles. Returns the item and a cancel().
 */
export function startUpload(
  boardId: string,
  ticketId: string,
  file: File,
  onChange: (item: UploadItem) => void,
): { item: UploadItem; cancel: () => void } {
  const id = newAttachmentId();
  const name = safeFileName(file.name);
  const path = storage.attachment(boardId, ticketId, id, name);
  const item: UploadItem = {
    id,
    name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    progress: 0,
    status: 'uploading',
    path,
    preview:
      file.type.startsWith('image/') && typeof URL !== 'undefined'
        ? URL.createObjectURL(file)
        : undefined,
  };
  const bad = rejectReason(file);
  if (bad) {
    const failed = { ...item, status: 'error' as const, error: bad };
    queueMicrotask(() => onChange(failed));
    return { item: failed, cancel: () => {} };
  }
  let task: UploadTask | null = null;
  try {
    task = uploadBytesResumable(ref(getStorageClient(), path), file, {
      contentType: item.mime,
      customMetadata: { originalName: file.name.slice(0, 255) },
    });
    task.on(
      'state_changed',
      (s) => onChange({ ...item, progress: s.totalBytes ? s.bytesTransferred / s.totalBytes : 0 }),
      (err) => {
        if ((err as { code?: string }).code === 'storage/canceled') return;
        onChange({ ...item, status: 'error', error: 'Upload failed' });
      },
      () => onChange({ ...item, progress: 1, status: 'done' }),
    );
  } catch {
    queueMicrotask(() => onChange({ ...item, status: 'error', error: 'Upload failed' }));
  }
  return { item, cancel: () => task?.cancel() };
}
