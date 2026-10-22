/**
 * The `.d.ts` kit artifacts are written against (the Code tab's editor and
 * any agent read it): what `host` is in `import { host } from
 * "@panth977/sandbox/artifact"`. It mirrors ./bridgeApi.ts and the DriverOps
 * table in @tm/shared (artifacts/driver.ts); keep the three in step.
 */
export const TM_HOST_TYPES = `
declare module "@panth977/sandbox/artifact" {
  type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
  type WhereOp = "<" | "<=" | "==" | "!=" | ">=" | ">" | "array-contains" | "in" | "not-in" | "array-contains-any";
  interface ListQuery {
    where?: [field: string, op: WhereOp, value: unknown][];
    orderBy?: [field: string, dir?: "asc" | "desc"];
    /** Capped at 500. */
    limit?: number;
    /** A document id to start after (paging). */
    startAfter?: string;
  }
  interface Doc<T = Record<string, any>> { id: string; path: string; exists: boolean; data: T | null }
  interface Me { uid: string; name: string | null; email: string | null; photoURL: string | null; role: "owner" | "editor" | "viewer"; readOnly: boolean }
  interface ArtifactInfo { id: string; name: string; buildId: string }
  interface Person { id: string; kind: "user" | "agent"; name: string; email: string }
  interface AggCounter { total: number; count: number }
  interface Board {
    id: string; key: string; name: string; access: "read" | "write"; canWrite: boolean;
    stages: { id: string; name: string; category: string }[];
    priorities: { id: string; name: string }[];
    tags: { id: string; name: string }[];
    fields: { id: string; name: string; type: string; options?: string[] }[];
    members: Person[];
    aggFields: { id: string; label: string; unit: string; period: "daily" | "weekly" | "monthly"; archived: boolean }[];
    aggs: Record<string, AggCounter>;
  }
  interface Ticket {
    id: string; key: string; board: string; url: string; title: string; description: string;
    stage: { id: string; name: string; category: string };
    priority: { id: string; name: string } | null;
    tags: string[]; assignees: Person[]; state: "active" | "archived";
    startAt: number | null; dueAt: number | null;
    /** Custom fields by name. */
    fields: Record<string, unknown>;
    messages: number; aggs: Record<string, AggCounter>; createdAt: number; updatedAt: number;
  }
  interface TicketQuery { stage?: string; assignee?: string | null; state?: "active" | "archived"; orderBy?: "rank" | "updated" | "created" | "due"; limit?: number }
  interface TicketInput {
    title: string; description?: string; stage?: string; priority?: string | null; tags?: string[];
    /** "me", emails or member ids. */
    assignees?: string[]; dueAt?: number | string | null; startAt?: number | string | null; fields?: Record<string, unknown>;
  }
  interface Message {
    id: string; kind: "comment" | "system" | "question" | "agg"; markdown: string; author: Person | null;
    attachments: { id: string; name: string; mime: string; size: number }[]; createdAt: number; [k: string]: unknown;
  }
  interface Aggregates {
    field: { id: string; label: string; unit: string; period: string; archived: boolean };
    from: string; to: string | null; total: number; count: number; lifetime: AggCounter;
    buckets: { key: string; total: number; count: number; tickets: Record<string, AggCounter> }[];
  }
  interface BucketInfo { id: string; name: string; description: string | null; icon: string | null; access: "read" | "write"; files: number; bytes: number }
  interface BucketNode { id: string; kind: "folder" | "file"; path: string; name: string; mime: string | null; size: number | null; updatedAt: number }

  interface HostApi {
    /** Who is looking. Every call runs as this person. */
    me(): Promise<Me>;
    artifact(): Promise<ArtifactInfo>;
    /** "readonly" (value: boolean) · "revoked" · "build" (a newer build id). */
    signals(): AsyncIterable<{ name: "readonly" | "revoked" | "build"; value: unknown }>;
    /** This artifact's Firestore. Paths are your own: "/orders/o1" (documents) or "/orders" (collections). */
    db: {
      get<T = Record<string, any>>(path: string): Promise<Doc<T>>;
      set(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): Promise<{ ok: true }>;
      update(path: string, patch: Record<string, unknown>): Promise<{ ok: true }>;
      delete(path: string): Promise<{ ok: true }>;
      add(collection: string, data: Record<string, unknown>): Promise<{ id: string; path: string }>;
      list<T = Record<string, any>>(collection: string, query?: ListQuery): Promise<Doc<T>[]>;
      /** Live: the document on every change. Break out of the loop to stop. */
      watch<T = Record<string, any>>(path: string): AsyncIterable<Doc<T>>;
      watchList<T = Record<string, any>>(collection: string, query?: ListQuery): AsyncIterable<Doc<T>[]>;
      /** Write this anywhere in a value to store the server's time. */
      serverTime(): Promise<{ __tm: "serverTime" }>;
    };
    /** This artifact's Realtime Database. */
    rtdb: {
      get<T = unknown>(path: string): Promise<T | null>;
      set(path: string, value: unknown): Promise<{ ok: true }>;
      update(path: string, patch: Record<string, unknown>): Promise<{ ok: true }>;
      push(path: string, value: unknown): Promise<{ key: string; path: string }>;
      remove(path: string): Promise<{ ok: true }>;
      watch<T = unknown>(path: string): AsyncIterable<T | null>;
    };
    /** This artifact's files. */
    files: {
      upload(path: string, blob: Blob, contentType?: string): Promise<{ path: string; size: number }>;
      url(path: string): Promise<{ url: string; expiresAt: number }>;
      list(path?: string): Promise<{ path: string; size: number; contentType: string | null; updatedAt: number }[]>;
      delete(path: string): Promise<{ ok: true }>;
    };
    /** A small key/value store per viewer (preferences, drafts). */
    kv: {
      get<T = unknown>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<{ ok: true }>;
      delete(key: string): Promise<{ ok: true }>;
    };
    /** Boards the owner granted this artifact; writes need a write grant AND the viewer's own role. */
    tickets: {
      boards(): Promise<Board[]>;
      list(board: string, query?: TicketQuery): Promise<Ticket[]>;
      watchList(board: string, query?: TicketQuery): AsyncIterable<Ticket[]>;
      get(key: string): Promise<Ticket | null>;
      create(board: string, ticket: TicketInput): Promise<{ id: string; key: string }>;
      update(key: string, patch: Partial<TicketInput>): Promise<{ ok: true }>;
      comment(key: string, markdown: string): Promise<{ ok: true }>;
      thread(key: string, query?: { limit?: number; before?: string | number }): Promise<Message[]>;
      watchThread(key: string, query?: { limit?: number }): AsyncIterable<Message[]>;
      fileUrl(key: string, file: string): Promise<{ url: string; expiresAt: number }>;
      aggregates(board: string, query?: { field?: string; from?: string; to?: string }): Promise<Aggregates>;
      watchAggregates(board: string, query?: { field?: string; from?: string; to?: string }): AsyncIterable<Aggregates>;
    };
    /** Buckets granted to this artifact. */
    bucket: {
      list(): Promise<BucketInfo[]>;
      tree(bucket: string, path?: string): Promise<BucketNode[]>;
      read(bucket: string, path: string): Promise<{ text: string; truncated: boolean }>;
      url(bucket: string, path: string): Promise<{ url: string; expiresAt: number }>;
      write(bucket: string, path: string, content: string | Blob, contentType?: string): Promise<{ path: string }>;
      mkdir(bucket: string, path: string): Promise<{ path: string }>;
      remove(bucket: string, path: string): Promise<{ ok: true }>;
    };
    /** The app's own UI, outside your frame. */
    ui: {
      toast(message: string, kind?: "info" | "success" | "warning" | "error"): Promise<void>;
      /** An app path ("/b/ENG") or an http(s) URL; opens in a new tab. */
      open(url: string): Promise<void>;
    };
  }
}
export {};
`;
