/**
 * What the driver's public API is written against: ONE request/subscribe
 * surface with two implementations — the host page over postMessage (./host)
 * and the in-browser mock (./mock). Because both speak the protocol's own
 * operation table (DriverOps), an artifact built against the mock makes the
 * very same calls once it is published.
 */
import type {
  DriverArgs,
  DriverArtifact,
  DriverError,
  DriverErrorCode,
  DriverMe,
  DriverOp,
  DriverResult,
} from '@tm/shared/artifacts/driver';

export type SubOp = 'fs.onDoc' | 'fs.onList' | 'rtdb.on' | 'tk.onList';
export type SignalName = 'readonly' | 'revoked' | 'build';

export interface Transport {
  request<O extends DriverOp>(op: O, args: DriverArgs<O>): Promise<DriverResult<O>>;
  /** Starts at once; returns the stop function. Errors (including a refused start) go to onError. */
  subscribe<O extends SubOp>(
    op: O,
    args: DriverArgs<O>,
    onValue: (value: unknown) => void,
    onError: (error: DriverError) => void,
  ): () => void;
}

export interface Session {
  transport: Transport;
  me: DriverMe;
  artifact: DriverArtifact;
  mock: boolean;
}

/** The slice of `window` the driver touches — so tests can hand it a fake one. */
export interface WindowLike {
  parent?: unknown;
  location?: { search?: string };
  /** A getter that THROWS in a sandboxed iframe — always read inside try/catch. */
  localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
}

export interface MessageEventLike {
  data: unknown;
  source: unknown;
  origin?: string;
}

/**
 * The Error an artifact catches. `code` is what to switch on; the class name
 * is fixed so a minified bundle still prints 'BackendDriverError'.
 */
export class BackendDriverError extends Error {
  readonly code: DriverErrorCode;
  constructor(code: DriverErrorCode, message: string) {
    super(message);
    this.name = 'BackendDriverError';
    this.code = code;
  }
}

const CODES: readonly DriverErrorCode[] = [
  'permission-denied',
  'not-found',
  'invalid-argument',
  'quota',
  'unavailable',
];

/** Anything thrown or received → a BackendDriverError. An unknown code reads as 'unavailable'. */
export function toDriverError(e: unknown): BackendDriverError {
  if (e instanceof BackendDriverError) return e;
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown };
  const code = CODES.includes(o.code as DriverErrorCode)
    ? (o.code as DriverErrorCode)
    : 'unavailable';
  const message =
    typeof o.message === 'string' && o.message ? o.message : String(e ?? 'Unknown error');
  return new BackendDriverError(code, message);
}

export const fail = (code: DriverErrorCode, message: string): never => {
  throw new BackendDriverError(code, message);
};
