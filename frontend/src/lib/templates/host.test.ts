/** The page side's watchdog (host.ts): a real hang is stopped, a sleeping page is not (ORCH-40). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateWorker, type TemplateBridge } from './host';
import type { ToWorker } from './protocol';

/** A worker that answers every ping, unless `hung`. */
function fakeWorker() {
  const w = {
    hung: false,
    terminated: false,
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null as unknown,
    postMessage(m: ToWorker) {
      if (w.hung || w.terminated) return;
      if (m.type === 'ping') queueMicrotask(() => w.onmessage?.({ data: { type: 'pong', n: m.n } }));
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

const bridge = {} as TemplateBridge;

function start() {
  const fw = fakeWorker();
  const errors: string[] = [];
  const t = new TemplateWorker({
    code: '',
    kind: 'script',
    ctx: {},
    bridge,
    spawn: () => fw as unknown as Worker,
    onError: (p) => errors.push(p.phase),
  });
  return { fw, t, errors };
}

describe('template watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops a worker that stops answering', async () => {
    const { fw, t, errors } = start();
    await vi.advanceTimersByTimeAsync(2000);
    fw.hung = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.stopped).toBe(true);
    expect(errors).toEqual(['timeout']);
  });

  it('keeps a worker alive across a page freeze (timers late, phone asleep)', async () => {
    const { t, errors } = start();
    await vi.advanceTimersByTimeAsync(2000);
    // The page froze for a minute: the clock moved, no timer ran.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.stopped).toBe(false);
    expect(errors).toEqual([]);
    t.destroy();
  });

  it('keeps a worker alive while the tab is hidden and throttled', async () => {
    const { fw, t, errors } = start();
    const doc = { hidden: true };
    vi.stubGlobal('document', doc);
    fw.hung = true; // a paused background worker answers nothing
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.stopped).toBe(false);
    doc.hidden = false;
    fw.hung = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.stopped).toBe(false);
    expect(errors).toEqual([]);
    t.destroy();
  });
});
