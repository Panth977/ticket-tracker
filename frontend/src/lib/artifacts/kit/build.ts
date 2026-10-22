/**
 * KIT BUILDS (docs/plan/artifacts.html §L). A kit artifact is published like
 * any other — a static folder through artifactPublish — and the folder says
 * what it is:
 *
 *   artifact.json   the compiled artifact (@panth977/sandbox CompiledArtifact)
 *   sbx-src.json    { files: { "/index.tsx": "…" } } — the source, for the Code tab
 *   index.html      a plain page for anyone who opens the build URL by hand
 *
 * The host fetches artifact.json through the build's capability URL (the
 * usercontent door answers CORS `*`), and runs it with the kit's render engine
 * instead of pointing an iframe at index.html. A build without artifact.json
 * is a classic static build and opens exactly as before.
 */
import type { CompiledArtifact } from '@panth977/sandbox/protocol';
import type { ArtifactInlineFile } from '@tm/shared';

export const KIT_ARTIFACT_FILE = 'artifact.json';
export const KIT_SOURCE_FILE = 'sbx-src.json';
/** Pinned kit version: the CDN copy the dev engine's language worker comes from. */
export const KIT_VERSION = '0.1.4';
export const KIT_CDN = `https://cdn.jsdelivr.net/gh/Panth977/sandbox-environment@v${KIT_VERSION}/dist`;

export type SourceFiles = Record<string, string>;

/** Does this look like a compiled artifact? (It came from somebody's build: check the shape.) */
export function isCompiledArtifact(v: unknown): v is CompiledArtifact {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<CompiledArtifact>;
  return (
    typeof a.protocol === 'number' &&
    typeof a.entry === 'string' &&
    !!a.modules &&
    typeof a.modules === 'object' &&
    typeof a.modules[a.entry] === 'string' &&
    Array.isArray(a.css) &&
    !!a.imports &&
    typeof a.imports === 'object' &&
    !!a.manifest &&
    typeof a.manifest === 'object'
  );
}

const fileUrl = (contentUrl: string, name: string) => new URL(name, contentUrl).toString();

const cache = new Map<string, Promise<CompiledArtifact | null>>();

/**
 * The compiled artifact of a build, or null for a classic build. Cached per
 * build id (a build never changes); a network failure is not cached.
 */
export function loadKitBuild(
  buildId: string,
  contentUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<CompiledArtifact | null> {
  const hit = cache.get(buildId);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetcher(fileUrl(contentUrl, KIT_ARTIFACT_FILE), { credentials: 'omit' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not load the artifact (${res.status})`);
    const type = res.headers.get('content-type') ?? '';
    // A miss can fall back to index.html (history routing): that is not a kit build.
    if (!type.includes('json')) return null;
    const json: unknown = await res.json().catch(() => null);
    return isCompiledArtifact(json) ? json : null;
  })();
  cache.set(buildId, p);
  p.catch(() => cache.delete(buildId));
  return p;
}

/** The source files a kit build carries, or null. */
export async function loadKitSources(
  contentUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<SourceFiles | null> {
  const res = await fetcher(fileUrl(contentUrl, KIT_SOURCE_FILE), { credentials: 'omit' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
  const json = (await res.json().catch(() => null)) as { files?: unknown } | null;
  const files = json?.files;
  if (!files || typeof files !== 'object') return null;
  const out: SourceFiles = {};
  for (const [k, v] of Object.entries(files)) if (typeof v === 'string') out[k] = v;
  return out;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The folder a kit build is published as (artifactPublish's inline `files`). */
export function kitBuildFiles(
  name: string,
  sources: SourceFiles,
  artifact: CompiledArtifact,
): ArtifactInlineFile[] {
  const index = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#444">
<p><b>${esc(name)}</b> is an artifact built with the Sandbox Environment kit.</p>
<p>Open it in the app to use it.</p></body></html>\n`;
  return [
    { path: 'index.html', content: index, encoding: 'utf8' },
    { path: KIT_ARTIFACT_FILE, content: JSON.stringify(artifact), encoding: 'utf8' },
    {
      path: KIT_SOURCE_FILE,
      content: JSON.stringify({ kit: KIT_VERSION, files: sources }),
      encoding: 'utf8',
    },
  ];
}
