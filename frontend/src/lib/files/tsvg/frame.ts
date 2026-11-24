/**
 * The TSVG player FRAME (agents.html §I): a `.tsvg` / `.tsvgz` attachment plays
 * in a sandboxed iframe, like an HTML file, never in the app's own document —
 * the viewer AND the card's still frame (poster mode) alike.
 *
 * TSVG itself carries no script — the XML is evaluated by the engine — but the
 * engine builds its options menu with innerHTML from the document's labels, and
 * a document may name assets by absolute URL. So it runs where neither can hurt:
 *
 *   sandbox="allow-scripts"   (TsvgFrame.svelte) NEVER allow-same-origin: an opaque
 *                             origin with no access to the app, its storage,
 *                             cookies or session
 *   srcdoc + CSP              scripts: our inline boot + the ONE pinned engine file
 *                             on esm.sh (with SRI); images, fonts and audio only
 *                             from blob:/data: — the package's own files
 *
 * The engine is the published package @panth977/tsvg (JSR), loaded as a classic
 * script from esm.sh — jsr.io serves HTML to browsers, not the file. To upgrade:
 * bump TSVG_ENGINE.version and set its sri (`curl -s <url> | openssl dgst
 * -sha384 -binary | openssl base64 -A`).
 *
 * The page hands the frame the file's bytes by postMessage (frame → 'tsvg:ready',
 * page → 'tsvg:load' { bytes }); the frame answers 'tsvg:loaded' { duration } or
 * 'tsvg:error' { message }, and forwards Escape so the viewer can still close.
 */

/** The TSVG engine this app plays with: one place to upgrade. */
export const TSVG_ENGINE = {
  version: '0.5.0',
  sri: 'sha384-MakKj73rRajykpeLe4qqW0qGvw7Gq1gY1U2bOWcUrVr3yrhxemoiypvnGSaoQv1/',
} as const;
/** The classic script (window.TSVG, TSVGZip, TSVGPlayer). CSP matches its path; `?raw` is ignored there. */
const ENGINE_PATH = `https://esm.sh/jsr/@panth977/tsvg@${TSVG_ENGINE.version}/dist/tsvg.js`;
export const TSVG_ENGINE_URL = `${ENGINE_PATH}?raw`;

const CSP =
  `default-src 'none'; script-src 'unsafe-inline' ${ENGINE_PATH}; style-src 'unsafe-inline'; ` +
  'img-src blob: data:; font-src blob: data:; media-src blob: data:';

export type FrameMessage =
  | { type: 'tsvg:ready' }
  | { type: 'tsvg:loaded'; duration: number }
  | { type: 'tsvg:error'; message: string }
  | { type: 'tsvg:escape' };

/** In-frame boot: wait for the bytes, then play them (a package, or a bare .tsvg). */
function boot(poster: boolean) {
  const w = window as unknown as {
    TSVG: unknown;
    TSVGZip: { isZip(b: Uint8Array): boolean };
    TSVGPlayer?: new (
      host: HTMLElement,
      o: { files: Record<string, string>; base: string; controls?: boolean },
    ) => {
      el: HTMLElement;
      doc: { duration: number };
      load(xml: string): Promise<{ duration: number }>;
      loadPackage(b: Uint8Array): Promise<{ duration: number }>;
      seek(t: number): void;
    };
  };
  const host = document.getElementById('p')!;
  const say = (m: unknown) => parent.postMessage(m, '*');
  window.addEventListener('message', async (e) => {
    if (e.source !== parent) return;
    const d = e.data as { type?: string; bytes?: ArrayBuffer } | null;
    if (!d || d.type !== 'tsvg:load' || !(d.bytes instanceof ArrayBuffer)) return;
    host.textContent = '';
    try {
      if (!w.TSVGPlayer) throw new Error('the TSVG player did not load (are you offline?)');
      const bytes = new Uint8Array(d.bytes);
      // A bare .tsvg's relative files resolve here — and the CSP refuses them.
      const p = new w.TSVGPlayer(host, { files: {}, base: 'https://tsvg.invalid/', controls: !poster });
      const doc = w.TSVGZip.isZip(bytes)
        ? await p.loadPackage(bytes)
        : await p.load(new TextDecoder().decode(bytes));
      if (poster) p.seek(Math.min(doc.duration * 0.25, 3));
      else p.el.focus();
      say({ type: 'tsvg:loaded', duration: doc.duration });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      host.innerHTML = '<div class="err"></div>';
      host.firstElementChild!.textContent = 'Could not play this file: ' + message;
      say({ type: 'tsvg:error', message });
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.fullscreenElement) say({ type: 'tsvg:escape' });
  });
  say({ type: 'tsvg:ready' });
}

const script = (src: string) => `<script>${src.replace(/<\/script/gi, '<\\/script')}</script>`;

/**
 * The frame's whole document. `poster`: a still frame for a card (no controls,
 * no input); otherwise the full player — timeline, chapters, speed, options.
 */
export function tsvgFrameHtml(poster = false): string {
  const css =
    'html,body,#p{margin:0;height:100%;background:#000;overflow:hidden}' +
    '#p .tsvgp{width:100%;height:100%;border-radius:0}' +
    '.err{display:grid;place-items:center;height:100%;padding:16px;box-sizing:border-box;' +
    'color:#ccc;font:13px system-ui,sans-serif;text-align:center}' +
    '';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${css}</style></head><body><div id="p"></div>` +
    `<script src="${TSVG_ENGINE_URL}" integrity="${TSVG_ENGINE.sri}" crossorigin="anonymous"></script>` +
    script(`(${boot.toString()})(${poster});`) +
    '</body></html>'
  );
}
