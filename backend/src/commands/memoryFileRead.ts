/**
 * memoryFileRead (memory.html §G) — one file: its text (a text file, or
 * asText) up to MEMORY_READ_TEXT_MAX_BYTES, and the file door's short-lived
 * URLs for anything (an image, a video, an APK).
 */
import { errors, isMemoryTextFile, MEMORY_READ_TEXT_MAX_BYTES } from '@tm/shared';
import { readStream } from '../adapters/files.js';
import { readTarget } from '../memory/nodes.js';
import { loadMemory, toNodeOut } from '../memory/shared.js';
import { signedAccess } from '../platform/fileAccess.js';
import { defineCommand } from './_registry.js';

async function readPrefix(
  path: string,
  size: number,
): Promise<{ text: string; truncated: boolean }> {
  const max = MEMORY_READ_TEXT_MAX_BYTES;
  if (size === 0) return { text: '', truncated: false };
  const end = Math.min(size, max) - 1;
  const chunks: Buffer[] = [];
  for await (const c of readStream(path, { start: 0, end })) chunks.push(c as Buffer);
  let buf = Buffer.concat(chunks);
  // Never cut a UTF-8 sequence in half at the limit.
  if (size > max)
    while (buf.length && (buf[buf.length - 1]! & 0xc0) === 0x80) buf = buf.subarray(0, -1);
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated: size > max };
}

export default defineCommand('memoryFileRead', async (ctx, input) => {
  const { memoryId } = input;
  await loadMemory(null, memoryId, ctx, 'read');
  const found = await readTarget(null, memoryId, input);
  const file = found.node.file;
  if (found.node.kind !== 'file' || !file)
    throw errors.invalid(`${found.node.path} is a folder — list it with memoryTree`, {
      field: 'path',
    });
  const access = await signedAccess(ctx, file.storagePath);
  const wantText = input.asText ?? isMemoryTextFile(found.node.name, file.mime);
  const read = wantText ? await readPrefix(file.storagePath, file.size) : null;
  return {
    node: toNodeOut(found.id, found.node),
    text: read?.text ?? null,
    truncated: read?.truncated ?? false,
    ...access,
  };
});
