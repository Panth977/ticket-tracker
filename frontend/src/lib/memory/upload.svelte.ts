/**
 * MEMORY UPLOADS (docs/plan/memory.html §F): the browser writes the bytes
 * straight to Storage at memoryStoragePath(memoryId, fileId, name) — with
 * progress, up to MEMORY_UPLOAD_MAX_BYTES — and then memoryFilePut registers
 * the node at its path (creating its parent folders, replacing a file that is
 * already there). One queue for the page, at most three files in flight.
 */
import { ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { MEMORY_UPLOAD_MAX_BYTES, formatBytes, memoryStoragePath } from '@tm/shared';
import { command } from '$lib/api';
import { safeFileName } from '$lib/editor/upload';
import { getStorageClient } from '$lib/firebase/client';

export type MemoryUploadStatus = 'queued' | 'uploading' | 'saving' | 'done' | 'error';

export interface MemoryUpload {
  key: string;
  memoryId: string;
  /** The node's path inside the memory. */
  path: string;
  name: string;
  size: number;
  progress: number;
  status: MemoryUploadStatus;
  error?: string;
}

/** A fresh id that fits MemoryFileIdSchema ([A-Za-z0-9_-]{6,64}). */
export function newFileId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 20);
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
}

/** Why this file cannot go in, or null. */
export function memoryRejectReason(file: { size: number }): string | null {
  if (file.size > MEMORY_UPLOAD_MAX_BYTES)
    return `Files are limited to ${formatBytes(MEMORY_UPLOAD_MAX_BYTES)}`;
  return null;
}

/** Where the bytes go: the object name is a Storage-safe version of the file's own name. */
export const objectPathFor = (memoryId: string, fileId: string, fileName: string): string =>
  memoryStoragePath(memoryId, fileId, safeFileName(fileName));

const MAX_PARALLEL = 3;

interface Job {
  item: MemoryUpload;
  file: Blob;
  mime: string;
  expectedFileId: string | null | undefined;
  task?: UploadTask;
  resolve: (ok: boolean) => void;
}

class MemoryUploads {
  items = $state<MemoryUpload[]>([]);
  private jobs: Job[] = [];
  private running = 0;

  /** Files still moving (the tray shows while this is > 0 or anything failed). */
  get active(): number {
    return this.items.filter((i) => i.status !== 'done' && i.status !== 'error').length;
  }

  /**
   * Upload `file` to `path` in the memory. Resolves true once the node is
   * registered. `expectedFileId` makes a replace conditional (Replace… on an
   * open file): a 409 if someone saved a newer version meanwhile.
   */
  add(
    memoryId: string,
    path: string,
    file: Blob & { name?: string },
    opts: { expectedFileId?: string | null } = {},
  ): Promise<boolean> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const item: MemoryUpload = {
      key: newFileId(),
      memoryId,
      path,
      name,
      size: file.size,
      progress: 0,
      status: 'queued',
    };
    const bad = memoryRejectReason(file);
    if (bad) {
      this.items = [...this.items, { ...item, status: 'error', error: bad }];
      return Promise.resolve(false);
    }
    this.items = [...this.items, item];
    return new Promise((resolve) => {
      this.jobs.push({
        item,
        file,
        mime: file.type || 'application/octet-stream',
        expectedFileId: opts.expectedFileId,
        resolve,
      });
      this.pump();
    });
  }

  private set(key: string, patch: Partial<MemoryUpload>) {
    this.items = this.items.map((i) => (i.key === key ? { ...i, ...patch } : i));
  }

  private pump() {
    while (this.running < MAX_PARALLEL && this.jobs.length) {
      const job = this.jobs.shift()!;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { item } = job;
    const fileId = newFileId();
    const storagePath = objectPathFor(item.memoryId, fileId, item.name);
    this.set(item.key, { status: 'uploading' });
    try {
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(ref(getStorageClient(), storagePath), job.file, {
          contentType: job.mime,
          customMetadata: { originalName: item.name.slice(0, 255) },
        });
        job.task = task;
        task.on(
          'state_changed',
          (s) =>
            this.set(item.key, { progress: s.totalBytes ? s.bytesTransferred / s.totalBytes : 0 }),
          reject,
          () => resolve(),
        );
      });
      this.set(item.key, { status: 'saving', progress: 1 });
      await command(
        'memoryFilePut',
        {
          memoryId: item.memoryId,
          path: item.path,
          storagePath,
          ...(job.expectedFileId !== undefined ? { expectedFileId: job.expectedFileId } : {}),
        },
        { toast: false },
      );
      this.set(item.key, { status: 'done' });
      job.resolve(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'storage/canceled') {
        this.items = this.items.filter((i) => i.key !== item.key);
        job.resolve(false);
        return;
      }
      this.set(item.key, {
        status: 'error',
        error:
          code === 'conflict'
            ? 'Changed by someone else meanwhile'
            : code === 'storage/unauthorized' || code === 'forbidden'
              ? 'Not allowed'
              : ((e as { message?: string }).message ?? 'Upload failed'),
      });
      job.resolve(false);
    }
  }

  cancel(key: string) {
    const j = this.jobs.find((x) => x.item.key === key);
    if (j) {
      this.jobs = this.jobs.filter((x) => x !== j);
      this.items = this.items.filter((i) => i.key !== key);
      j.resolve(false);
    }
  }

  /** Drop finished and failed rows (the tray's ×). */
  clear() {
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'error');
  }
}

export const memoryUploads = new MemoryUploads();

/**
 * Every file in a DataTransfer — folders included (webkitGetAsEntry) — with
 * its path relative to what was dropped ('photos/2024/a.jpg').
 */
export async function filesFromDrop(dt: DataTransfer): Promise<{ file: File; relative: string }[]> {
  const out: { file: File; relative: string }[] = [];
  type Entry = {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    fullPath: string;
    file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
    createReader?: () => {
      readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void;
    };
  };
  const entries: Entry[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    const e = (
      it as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }
    ).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (!entries.length) {
    for (const f of Array.from(dt.files ?? [])) out.push({ file: f, relative: f.name });
    return out;
  }
  async function walk(e: Entry): Promise<void> {
    if (e.isFile && e.file) {
      const f = await new Promise<File>((ok, err) => e.file!(ok, err));
      out.push({ file: f, relative: e.fullPath.replace(/^\//, '') || f.name });
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      // readEntries answers in batches until it answers [].
      for (;;) {
        const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

/** <input type=file webkitdirectory> / multiple → relative paths. */
export function filesFromInput(list: FileList | null): { file: File; relative: string }[] {
  return Array.from(list ?? []).map((f) => ({
    file: f,
    relative: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
  }));
}
