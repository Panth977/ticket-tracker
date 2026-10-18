/**
 * The browser's half of a Drive upload (bucket.html §K4): bucketDriveUpload
 * opened a resumable session in Google Drive; the whole body goes there in one
 * PUT, with progress. Nothing passes through our object store or our server.
 */
import type { CommandRes } from '@tm/shared';
import { command } from '$lib/api';
import { newAttachmentId, rejectReason, type UploadItem } from '$lib/editor/upload';

export type DriveUploadInput = Omit<
  Parameters<typeof command<'bucketDriveUpload'>>[1],
  'size' | 'mime' | 'origin'
>;

/** PUT `blob` to a session URL. Resolves when Drive (or the dev fake) says done. */
export function putToDrive(
  url: string,
  blob: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Google Drive refused the upload (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Could not reach Google Drive'));
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { code: 'storage/canceled' }));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

/** Open the session and send the bytes: the file is in Drive when this resolves. */
export async function uploadToDrive(
  input: DriveUploadInput,
  blob: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<CommandRes<'bucketDriveUpload'>> {
  const session = await command(
    'bucketDriveUpload',
    {
      ...input,
      size: blob.size,
      mime: blob.type || 'application/octet-stream',
      origin: location.origin,
    },
    { toast: false },
  );
  await putToDrive(session.uploadUrl, blob, onProgress, signal);
  return session;
}

/**
 * A ticket file into a Drive bucket (§J, §K4), shaped like editor/upload's
 * startUpload: the item's `path` becomes the Drive storagePath once the
 * session is open, and that is what bucketUploads names on send.
 */
export function startDriveAttach(
  file: File,
  target: { bucketId: string; boardId: string; name: string; bucketPath: string },
  onChange: (item: UploadItem) => void,
): { item: UploadItem; cancel: () => void } {
  const item: UploadItem = {
    id: newAttachmentId(),
    name: target.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    progress: 0,
    status: 'uploading',
    path: '',
    bucketId: target.bucketId,
    bucketPath: target.bucketPath,
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
  const abort = new AbortController();
  let path = '';
  void uploadToDrive(
    { bucketId: target.bucketId, purpose: 'attach', boardId: target.boardId, name: target.name },
    file,
    (progress) => onChange({ ...item, path, progress }),
    abort.signal,
  )
    .then((s) => {
      path = s.storagePath;
      onChange({ ...item, path, progress: 1, status: 'done' });
    })
    .catch((e: { code?: string; message?: string }) => {
      if (e.code === 'storage/canceled') return;
      onChange({ ...item, status: 'error', error: e.message ?? 'Upload failed' });
    });
  return { item, cancel: () => abort.abort() };
}
