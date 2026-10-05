/**
 * Server-Sent Events, parsed by hand.
 *
 * `EventSource` is not in Node, cannot send an Authorization header, and
 * cannot be given a fetch — so the SDK reads the stream itself. The wire
 * format is the one /v1/events/stream writes (shared/api/rest.ts):
 *
 *   event: event     id: <cursor>   data: <PublicEvent JSON>
 *   event: ping                                     (keep-alive)
 *
 * Reconnects resume with `Last-Event-ID`, so no event is seen twice and none
 * is skipped; the server also closes every stream at ~50 s (it lives inside a
 * 60 s function), which is a normal end, not a failure.
 *
 * ⚠ WHAT /v1/events/stream COSTS (docs/plan/agents.html §W). Holding that
 * stream open holds a Cloud Run request open, and Cloud Run bills CPU for a
 * request's whole life, waiting included — so an always-connected agent on
 * SSE is the most expensive thing this API offers. `tm.watch()` waits on the
 * Realtime Database instead (held by Google's edge, billed by bandwidth) and
 * calls REST only when something changed. This parser serves BOTH: the RTDB's
 * own REST stream is plain SSE too, which is why there is no Firebase SDK
 * anywhere in this package.
 */

/** One `event:`/`id:`/`data:` block from the wire. */
export interface SseFrame {
  event: string;
  id: string | null;
  data: string;
  /** The server's `retry:` hint, in ms. */
  retry: number | null;
}

/**
 * Split a byte stream into SSE frames. Handles frames split across chunks,
 * CRLF, comment lines (`:`) and multi-line `data:`.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = (): void => void reader.cancel().catch(() => void 0);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames end at a blank line; \r\n\r\n and \n\n both count.
      let cut: number;
      while ((cut = indexOfFrameEnd(buffer)) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^(\r?\n){2}/, '');
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
    const tail = parseFrame(buffer.trim());
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** One block of `field: value` lines → a frame, or null when it holds nothing. */
export function parseFrame(block: string): SseFrame | null {
  if (!block.trim()) return null;
  let event = 'message';
  let id: string | null = null;
  let retry: number | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // comments and blank lines
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    // "Only one leading space after the colon is part of the delimiter."
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'retry') {
      const n = Number(value);
      if (Number.isFinite(n)) retry = n;
    }
  }
  if (event === 'message' && !data.length && id === null && retry === null) return null;
  return { event, id, data: data.join('\n'), retry };
}
