/** Types for attachments-to-memory.mjs (loose on purpose: it takes @tm/shared and the Admin SDK as arguments). */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Shared = any;

export interface Move {
  oldPath: string;
  rowIds: string[];
  nodeId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  width?: number | undefined;
  height?: number | undefined;
  createdAt: number;
  uploadedBy: string;
  path: string;
  reused: boolean;
  renamed: boolean;
}
export interface Skip {
  rowId: string;
  path: string;
  reason: string;
}
export interface PlanState {
  taken: Map<string, 'file' | 'folder' | string>;
  nodesById: Map<string, { path: string }>;
  objects: Map<string, { exists: boolean; size?: number; contentType?: string }>;
}
export interface Summary {
  memoryId: string | null;
  memoryCreated: boolean;
  boards: number;
  archivedBoards: number;
  grants: number;
  grantsMax: number;
  grantsToWrite: number;
  attachMemoryToWrite: number;
  attachMemoryReplaced: { board: string; was: unknown }[];
  tickets: number;
  ticketsToChange: number;
  filesToMove: number;
  filesReused: number;
  bytes: number;
  renamed: number;
  foldersToCreate: number;
  refsToRewrite: number;
  skipped: (Skip & { ticket: string })[];
  orphans: { ticket: string; messageId: string; path: string }[];
  nodesExisting: number;
  nodesMax: number;
  stopped?: string;
  applied: {
    tickets: number;
    files: number;
    folders: number;
    copied: number;
    refs: number;
    failed: { ticket: string; error: string }[];
  };
}

export const MIGRATION_STAMP: string;
export const DEFAULT_MEMORY_NAME: string;
export const DEFAULT_MEMORY_DESCRIPTION: string;
export const MAX_WRITES_PER_TICKET: number;
export function randomId(n?: number): string;
export function nodeIdFor(oldPath: string): string;
export function fileIdFor(oldPath: string): string;
export function boardTemplate(boardKey: string): string;
export function classifyRow(S: Shared, row: any): 'memory' | 'deleted' | 'foreign' | 'move';
export function targetPathFor(
  S: Shared,
  boardKey: string,
  ticketKey: string,
  row: any,
): string | null;
export function parentPaths(path: string): string[];
export function allocatePath(
  S: Shared,
  wanted: string,
  taken: Map<string, string>,
):
  | { path: string; n: number; error?: undefined }
  | { error: string; path?: undefined; n?: undefined };
export function take(taken: Map<string, string>, path: string): void;
export function planTicket(
  S: Shared,
  state: PlanState,
  board: { key: string },
  ticket: any,
): { moves: Move[]; skipped: Skip[] };
export function foldersToCreate(paths: string[], existing: Map<string, unknown>): string[];
export function storagePathFor(S: Shared, memoryId: string, move: Move): string;
export function fileNodeFor(S: Shared, memoryId: string, move: Move, parentId: string | null): any;
export function folderNodeFor(
  S: Shared,
  parentId: string | null,
  path: string,
  by: string,
  now: number,
): any;
export function rewriteAttachment<T>(
  S: Shared,
  a: T,
  refs: Map<string, string>,
  memoryId: string,
): T;
export function rewriteTicket(
  S: Shared,
  ticket: any,
  refs: Map<string, string>,
  memoryId: string,
): { files: any[]; recentMessages: any[]; changed: number };
export function rewriteMessages(
  S: Shared,
  messages: any[],
  refs: Map<string, string>,
  memoryId: string,
): { messages: any[]; changed: number };
export function orphanMessageAttachments(
  S: Shared,
  ticket: any,
  pages: any[],
): { messageId: string; path: string }[];
export function migrateAttachmentsToMemory(
  deps: { S: Shared; db: any; bucket: any; FieldValue: any },
  opts: {
    ownerUid: string;
    memoryName?: string;
    apply?: boolean;
    log?: (m: string) => void;
    now?: number;
    sample?: number;
  },
): Promise<Summary>;
