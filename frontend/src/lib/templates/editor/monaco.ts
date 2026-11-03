/**
 * Monaco (the editor of VS Code), loaded once per page from the same pinned CDN
 * build the artifact Code tab uses (@panth977/sandbox's dev engine). The `min`
 * build is AMD: its loader goes on the page once; its workers are started from a
 * same-origin blob that importScripts the CDN file.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Monaco is loaded at run time, untyped */
export type Monaco = any;

export const MONACO_VERSION = '0.57.0';
const BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;
/** Worker files of the pinned version (content-hashed, as the kit lists them). */
const WORKERS: Record<string, string> = {
  editor: 'editor.worker-_vAIFJDs.js',
  json: 'json.worker-Csf_TLih.js',
  css: 'css.worker-BpD9FCKP.js',
  html: 'html.worker-CLuInTTy.js',
  ts: 'ts.worker-g3pjEjl4.js',
};

function workerFor(label: string): Worker {
  const file =
    label === 'json'
      ? WORKERS.json
      : label === 'css' || label === 'scss' || label === 'less'
        ? WORKERS.css
        : label === 'html' || label === 'handlebars' || label === 'razor'
          ? WORKERS.html
          : label === 'typescript' || label === 'javascript'
            ? WORKERS.ts
            : WORKERS.editor;
  const src = `importScripts(${JSON.stringify(`${BASE}/vs/assets/${file}`)});`;
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), {
    name: label,
  });
}

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  const g = globalThis as any;
  if (g.monaco?.editor) return Promise.resolve(g.monaco);
  if (loading) return loading;
  loading = new Promise<Monaco>((resolve, reject) => {
    g.MonacoEnvironment = {
      ...(g.MonacoEnvironment ?? {}),
      getWorker: (_id: string, label: string) => workerFor(label),
    };
    const ready = () => {
      const req = g.require;
      req.config({ paths: { vs: `${BASE}/vs` } });
      req(
        ['vs/editor/editor.main'],
        (m: Monaco) => {
          if (g.define?.amd) g.define.amd = undefined;
          resolve(g.monaco ?? m);
        },
        (e: unknown) => reject(e),
      );
    };
    if (typeof g.require?.config === 'function' && g.define?.amd !== undefined) return ready();
    const s = document.createElement('script');
    s.src = `${BASE}/vs/loader.js`;
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error('Could not load the editor'));
    document.head.append(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}
