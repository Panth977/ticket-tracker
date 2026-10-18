/**
 * ANY DOCUMENT AS A JSON FILE (docs/plan/bucket.html §L5) — what an entity
 * keeps in Drive besides its tickets: a board's views and templates, a
 * dictionary's entries, an artifact's data tabs, every entity's settings file.
 *
 * A document's path under its entity maps straight onto folders:
 *
 *   boards/{b}/views/{v}                     → <board folder>/views/{v}.json
 *   artifacts/{a}/db/data/orders/{o}         → <artifact folder>/db/data/orders/{o}.json
 *   dictionaries/{d}/content/entries         → <dictionary folder>/content/entries.enc.json (secret)
 *
 * A secret subtree's files are sealed with the entity's data key (keyring.ts)
 * and named `.enc.json`; everything else is plain, readable JSON.
 *
 * Reads go through files.ts's cache (a file's head revision says whether to
 * download it again); folder ids are remembered per process.
 */
import type { DriveApi, DriveItem } from '../../bucket/drive/api.js';
import { isFolder } from '../../bucket/drive/api.js';
import { JSON_MIME, pool, readJsonFile, rememberJson } from './files.js';

type Json = Record<string, unknown>;

/** Seal / open a secret file's contents (keyring.ts supplies these per entity). */
export interface Sealer {
  seal(json: Json): Promise<Json>;
  open(json: Json): Promise<Json>;
}

const folders = new Map<string, string>();
const folderKey = (root: string, segs: readonly string[]) => `${root}/${segs.join('/')}`;
/** Tests. */
export const clearDocFolderCache = () => folders.clear();

/** The folder at `segs` under `root` (made when `create`); null when missing. */
export async function folderAt(
  drive: DriveApi,
  root: string,
  segs: readonly string[],
  create: boolean,
): Promise<string | null> {
  let parent = root;
  for (let i = 0; i < segs.length; i++) {
    const key = folderKey(root, segs.slice(0, i + 1));
    const hit = folders.get(key);
    if (hit) {
      parent = hit;
      continue;
    }
    const kids = await drive.children([parent]);
    const found = kids.find((k) => isFolder(k) && k.name === segs[i]);
    if (!found && !create) return null;
    const id = found ? found.id : (await drive.createFolder(parent, segs[i]!)).id;
    folders.set(key, id);
    parent = id;
  }
  return parent;
}

const fileName = (id: string, secret: boolean) => `${id}${secret ? '.enc' : ''}.json`;
const idOf = (name: string): string | null => {
  const m = /^(.+?)(\.enc)?\.json$/.exec(name);
  return m ? m[1]! : null;
};

async function find(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
  secret: boolean,
  create: boolean,
): Promise<{ folder: string | null; file: DriveItem | null }> {
  const folder = await folderAt(drive, root, rel.slice(0, -1), create);
  if (!folder) return { folder: null, file: null };
  const name = fileName(rel[rel.length - 1]!, secret);
  let kids: DriveItem[];
  try {
    kids = await drive.children([folder]);
  } catch (e) {
    folders.clear(); // a folder moved or trashed in Drive: look it up again next time
    throw e;
  }
  return { folder, file: kids.find((k) => !isFolder(k) && k.name === name) ?? null };
}

/** One document; undefined when there is none. */
export async function readDocFile(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
  sealer: Sealer | null,
): Promise<{ doc: Json | undefined; fileId: string | null }> {
  const { file } = await find(drive, root, rel, !!sealer, false);
  if (!file) return { doc: undefined, fileId: null };
  const raw = await readJsonFile(drive, file);
  return { doc: sealer ? await sealer.open(raw) : raw, fileId: file.id };
}

/** Write (or, `doc` undefined, trash) one document. Answers its file id. */
export async function writeDocFile(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
  doc: Json | undefined,
  sealer: Sealer | null,
  known?: string | null,
): Promise<string | null> {
  const { folder, file } = known
    ? { folder: null, file: { id: known } as DriveItem }
    : await find(drive, root, rel, !!sealer, doc !== undefined);
  if (doc === undefined) {
    if (file) await drive.trash(file.id).catch(() => undefined);
    return null;
  }
  const body = sealer ? await sealer.seal(doc) : doc;
  const f = await drive.putSmall({
    fileId: file?.id,
    create: file
      ? undefined
      : { parentId: folder!, name: fileName(rel[rel.length - 1]!, !!sealer) },
    mime: JSON_MIME,
    bytes: new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`),
  });
  rememberJson(f, body);
  return f.id;
}

/** Every document directly in the folder at `rel` (a collection). */
export async function listDocFiles(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
  sealer: Sealer | null,
): Promise<{ id: string; doc: Json }[]> {
  const folder = await folderAt(drive, root, rel, false);
  if (!folder) return [];
  const files = (await drive.children([folder])).filter(
    (k) => !isFolder(k) && k.name.endsWith('.json') && !k.name.startsWith('.'),
  );
  const rows = await pool(files, 12, async (f) => {
    const id = idOf(f.name);
    if (!id) return null;
    const raw = await readJsonFile(drive, f);
    return { id, doc: sealer ? await sealer.open(raw) : raw };
  });
  return rows.filter((r): r is { id: string; doc: Json } => r !== null);
}

/** Trash the folder of a subtree (a collection deleted whole). */
export async function trashFolder(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
): Promise<void> {
  const folder = await folderAt(drive, root, rel, false);
  if (folder) await drive.trash(folder).catch(() => undefined);
  for (const k of [...folders.keys()]) if (k.startsWith(folderKey(root, rel))) folders.delete(k);
}

/** The names of the folders directly in the folder at `rel` (a document's subcollections, or a collection's documents). */
export async function childFolders(
  drive: DriveApi,
  root: string,
  rel: readonly string[],
): Promise<string[]> {
  const folder = await folderAt(drive, root, rel, false);
  if (!folder) return [];
  return (await drive.children([folder]))
    .filter((k) => isFolder(k) && !k.name.startsWith('.'))
    .map((k) => k.name);
}
