/**
 * `use:visible={(on) => …}` — tells a card when it first scrolls near the
 * viewport, so previews (text reads, HTML iframes, video metadata) load
 * lazily. Without IntersectionObserver (tests) it fires at once.
 */
export function visible(node: Element, cb: (on: boolean) => void) {
  let fn = cb;
  if (typeof IntersectionObserver === 'undefined') {
    queueMicrotask(() => fn(true));
    return { update: (c: typeof cb) => (fn = c) };
  }
  const io = new IntersectionObserver(
    ([e]) => {
      if (e?.isIntersecting) {
        fn(true);
        io.disconnect();
      }
    },
    { rootMargin: '200px' },
  );
  io.observe(node);
  return { update: (c: typeof cb) => (fn = c), destroy: () => io.disconnect() };
}
