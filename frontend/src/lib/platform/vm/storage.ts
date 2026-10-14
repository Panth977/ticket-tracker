/**
 * `firebase/storage` FOR THE VM BUILD — uploads and download URLs against the
 * server's disk store (backend doors/blob.ts, /blob/o/…), each checked by the
 * same storage.rules with the signed-in user's ID token.
 *
 *   uploadBytes, uploadBytesResumable (an UploadTask with on/then/cancel and
 *   byte progress), getDownloadURL; errors carry Firebase's codes
 *   (storage/unauthorized, storage/canceled, storage/object-not-found …).
 */
import { currentIdToken } from './auth';
import { LiveError } from './live';

export class FirebaseStorage {
  readonly bucket = 'default';
}
const STORAGE = new FirebaseStorage();
export const getStorage = (..._a: unknown[]) => STORAGE;
export const connectStorageEmulator = (..._a: unknown[]) => {};

export class StorageReference {
  readonly bucket = 'default';
  readonly storage = STORAGE;
  constructor(readonly fullPath: string) {}
  get name(): string {
    return this.fullPath.split('/').pop() ?? '';
  }
  get parent(): StorageReference | null {
    return this.fullPath ? new StorageReference(this.fullPath.split('/').slice(0, -1).join('/')) : null;
  }
  toString(): string {
    return `gs://${this.bucket}/${this.fullPath}`;
  }
}
export const ref = (_s: FirebaseStorage | StorageReference, path = '') =>
  new StorageReference(
    [_s instanceof StorageReference ? _s.fullPath : '', path].join('/').split('/').filter(Boolean).join('/'),
  );

export class StorageError extends LiveError {
  readonly status_: number;
  constructor(code: string, message: string, status = 0) {
    super(code, message);
    this.status_ = status;
  }
}

interface Metadata {
  contentType?: string;
  customMetadata?: Record<string, string>;
  cacheControl?: string;
}

const objectUrl = (r: StorageReference) =>
  `/blob/o/${encodeURIComponent(r.bucket)}/${r.fullPath.split('/').map(encodeURIComponent).join('/')}`;

async function headers(): Promise<Record<string, string>> {
  const t = await currentIdToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

function fail(status: number, body: string): StorageError {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error;
    if (e?.code) return new StorageError(e.code, e.message ?? 'Storage error', status);
  } catch {
    /* not JSON */
  }
  return new StorageError(status === 403 ? 'storage/unauthorized' : 'storage/unknown', `Storage error (${status})`, status);
}

const sizeOf = (data: Blob | Uint8Array | ArrayBuffer) => (data instanceof Blob ? data.size : data.byteLength);
const typeOf = (data: Blob | Uint8Array | ArrayBuffer, m?: Metadata) =>
  m?.contentType || (data instanceof Blob && data.type) || 'application/octet-stream';

export interface UploadTaskSnapshot {
  bytesTransferred: number;
  totalBytes: number;
  state: 'running' | 'paused' | 'success' | 'canceled' | 'error';
  ref: StorageReference;
  metadata: Record<string, unknown> | null;
  task: UploadTask;
}

type Next = (s: UploadTaskSnapshot) => void;
type Err = (e: StorageError) => void;

export class UploadTask {
  snapshot: UploadTaskSnapshot;
  private readonly xhr = new XMLHttpRequest();
  private readonly done: Promise<UploadTaskSnapshot>;
  private readonly observers: { next?: Next; error?: Err; complete?: () => void }[] = [];

  constructor(r: StorageReference, data: Blob | Uint8Array | ArrayBuffer, m?: Metadata) {
    this.snapshot = { bytesTransferred: 0, totalBytes: sizeOf(data), state: 'running', ref: r, metadata: null, task: this };
    this.done = new Promise((resolve, reject) => {
      const emit = () => this.observers.forEach((o) => o.next?.(this.snapshot));
      const error = (e: StorageError) => {
        this.snapshot = { ...this.snapshot, state: e.code === 'storage/canceled' ? 'canceled' : 'error' };
        this.observers.forEach((o) => o.error?.(e));
        reject(e);
      };
      this.xhr.upload.onprogress = (e) => {
        this.snapshot = { ...this.snapshot, bytesTransferred: e.loaded };
        emit();
      };
      this.xhr.onload = () => {
        if (this.xhr.status < 200 || this.xhr.status >= 300) return error(fail(this.xhr.status, this.xhr.responseText));
        this.snapshot = { ...this.snapshot, bytesTransferred: this.snapshot.totalBytes, state: 'success', metadata: JSON.parse(this.xhr.responseText) as Record<string, unknown> };
        emit();
        this.observers.forEach((o) => o.complete?.());
        resolve(this.snapshot);
      };
      this.xhr.onerror = () => error(new StorageError('storage/retry-limit-exceeded', 'Network error during upload'));
      this.xhr.onabort = () => error(new StorageError('storage/canceled', 'User canceled the upload/download.'));
    });
    this.done.catch(() => {}); // observed through on()/then()
    void headers().then((h) => {
      if (this.snapshot.state === 'canceled') return;
      this.xhr.open('POST', objectUrl(r));
      for (const [k, v] of Object.entries(h)) this.xhr.setRequestHeader(k, v);
      this.xhr.setRequestHeader('content-type', typeOf(data, m));
      if (m?.customMetadata) this.xhr.setRequestHeader('x-tm-metadata', JSON.stringify(m.customMetadata));
      this.xhr.send(data instanceof Blob ? data : new Blob([data as BlobPart]));
    });
  }

  on(_event: 'state_changed', next?: Next | { next?: Next; error?: Err; complete?: () => void } | null, error?: Err | null, complete?: (() => void) | null): () => void {
    const o = typeof next === 'object' && next ? next : { next: next ?? undefined, error: error ?? undefined, complete: complete ?? undefined };
    this.observers.push(o);
    return () => {
      const i = this.observers.indexOf(o);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }
  cancel(): boolean {
    if (this.snapshot.state !== 'running') return false;
    this.snapshot = { ...this.snapshot, state: 'canceled' };
    this.xhr.abort();
    if (this.xhr.readyState === 0) this.observers.forEach((o) => o.error?.(new StorageError('storage/canceled', 'User canceled the upload/download.')));
    return true;
  }
  pause(): boolean {
    return false;
  }
  resume(): boolean {
    return false;
  }
  then<T1 = UploadTaskSnapshot, T2 = never>(ok?: ((s: UploadTaskSnapshot) => T1 | PromiseLike<T1>) | null, ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null): Promise<T1 | T2> {
    return this.done.then(ok, ko);
  }
  catch<T = never>(ko?: ((e: unknown) => T | PromiseLike<T>) | null): Promise<UploadTaskSnapshot | T> {
    return this.done.catch(ko);
  }
}

export const uploadBytesResumable = (r: StorageReference, data: Blob | Uint8Array | ArrayBuffer, m?: Metadata) => new UploadTask(r, data, m);

export async function uploadBytes(r: StorageReference, data: Blob | Uint8Array | ArrayBuffer, m?: Metadata) {
  const res = await fetch(objectUrl(r), {
    method: 'POST',
    headers: {
      ...(await headers()),
      'content-type': typeOf(data, m),
      ...(m?.customMetadata ? { 'x-tm-metadata': JSON.stringify(m.customMetadata) } : {}),
    },
    body: data instanceof Blob ? data : new Blob([data as BlobPart]),
  });
  const text = await res.text();
  if (!res.ok) throw fail(res.status, text);
  return { ref: r, metadata: JSON.parse(text) as Record<string, unknown> };
}

export async function getDownloadURL(r: StorageReference): Promise<string> {
  const res = await fetch(objectUrl(r), { headers: await headers() });
  const text = await res.text();
  if (!res.ok) throw fail(res.status, text);
  return (JSON.parse(text) as { url: string }).url;
}

export async function getMetadata(r: StorageReference) {
  const res = await fetch(objectUrl(r), { headers: await headers() });
  const text = await res.text();
  if (!res.ok) throw fail(res.status, text);
  return JSON.parse(text) as Record<string, unknown>;
}

export type { UploadTask as UploadTaskType };
