/**
 * BUCKETS IN GOOGLE DRIVE (docs/plan/bucket.html §K).
 *
 * A bucket's STORAGE is chosen when it is created and never changes:
 *
 *   managed  (default, no `storage` field)  nodes in Firestore, bytes in our
 *            object store — everything §A–§J describe.
 *   drive    the bucket IS a folder in its creator's Google Drive. Drive is the
 *            single source of truth: the tree is Drive's folders and files,
 *            a node's id is the Drive file id, a version is Drive's head
 *            revision. Firestore keeps only the bucket document (its people,
 *            grants and the folder it points at) — no nodes, no copies.
 *
 * People reach a Drive bucket exactly as any other (§B, §D): the server talks
 * to Drive with the CONNECTED person's token, so nobody else needs a Drive
 * share. The permission is Google's `drive.file`: the app sees only what it
 * created there, or what the person picked with Google's folder picker.
 */
import { z } from 'zod';
import { MillisSchema, UidSchema } from '../types/index.js';

export const BUCKET_STORAGE_KINDS = ['managed', 'drive'] as const;
export const BucketStorageKindSchema = z.enum(BUCKET_STORAGE_KINDS);
export type BucketStorageKind = z.infer<typeof BucketStorageKindSchema>;

/** A Drive file or folder id (Drive's own alphabet). */
export const DriveIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,128}$/, 'Drive id');

/** bucket.storage for a Drive bucket. Absent on a managed one. */
export const BucketDriveStorageSchema = z.object({
  kind: z.literal('drive'),
  /** Whose Drive (the person who created it). Their connection is used for every call. */
  uid: UidSchema,
  /** The bucket's root folder in that Drive. */
  folderId: DriveIdSchema,
  /** Its name when chosen, for the UI (Drive is the truth; this is a label). */
  folderName: z.string().max(255),
  /** The Google account's address, for "Stored in x@gmail.com's Drive". */
  email: z.string().max(320).nullable(),
});
export type BucketDriveStorage = z.infer<typeof BucketDriveStorageSchema>;

/** The storage kind of a bucket document. */
export const bucketStorageKind = (b: { storage?: { kind: string } | null | undefined }) =>
  (b.storage?.kind === 'drive' ? 'drive' : 'managed') as BucketStorageKind;

/**
 * What bucketCreate (and boardCreate / artifactCreate's "storage" question)
 * accepts. `folderId`: a folder the person picked in Google's picker; else
 * `folderPath` ('TaskManager/Specs'), created in their Drive's top level
 * when missing (default: 'TaskManager/{bucket name}').
 */
export const BucketStorageInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('managed') }),
  z.object({
    kind: z.literal('drive'),
    folderId: DriveIdSchema.optional(),
    folderPath: z.string().trim().max(1024).optional(),
  }),
]);
export type BucketStorageInput = z.infer<typeof BucketStorageInputSchema>;

/** The scope the app asks Google for — nothing broader (§K1). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Where a Drive bucket lives when the person names no folder. */
export const DRIVE_DEFAULT_PARENT = 'TaskManager';

/** Folder MIME type in Drive. */
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * A Drive file's bytes, as the file door addresses them: drive/{bucketId}/{driveId}/{name}.
 * Like bucketStoragePath, but no object lives in OUR store there — the server
 * reads it from Drive with the bucket's connection.
 */
export const driveStoragePath = (bucketId: string, driveId: string, fileName: string): string =>
  `drive/${bucketId}/${driveId}/${fileName}`;

const DRIVE_OBJECT = /^drive\/([A-Za-z0-9_-]{6,64})\/([A-Za-z0-9_-]{6,128})\/([^/]+)$/;

export function parseDriveStoragePath(
  path: string,
): { bucketId: string; driveId: string; fileName: string } | null {
  const m = DRIVE_OBJECT.exec(path);
  return m ? { bucketId: m[1]!, driveId: m[2]!, fileName: m[3]! } : null;
}

/** Account › Connections: is my Drive connected? (driveStatus) */
export const DriveStatusSchema = z.object({
  /** Is the server configured for Drive at all (a Google OAuth client)? */
  available: z.boolean(),
  connected: z.boolean(),
  email: z.string().nullable(),
  connectedAt: MillisSchema.nullable(),
  /** Can the app show Google's folder picker (an API key is configured)? */
  picker: z.boolean(),
});
export type DriveStatus = z.infer<typeof DriveStatusSchema>;
