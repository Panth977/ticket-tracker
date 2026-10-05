/**
 * memoryFilePut (memory.html §F) — register a file the APP uploaded straight
 * to Storage at memories/{memoryId}/{fileId}/{name} (storage.rules lets an
 * owner or editor create there, once). Size and content type come from the
 * object itself, never from the request.
 */
import { errors, MEMORY_UPLOAD_MAX_BYTES, parseMemoryStoragePath } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { putVersion } from '../memory/files.js';
import { loadMemory } from '../memory/shared.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryFilePut', async (ctx, input) => {
  const { memoryId, storagePath } = input;
  await loadMemory(null, memoryId, ctx, 'write');
  const p = parseMemoryStoragePath(storagePath);
  if (!p || p.memoryId !== memoryId)
    throw errors.invalid("Upload under this memory's folder: memories/{memoryId}/{fileId}/{name}", {
      field: 'storagePath',
    });
  const obj = await ports().files.stat(storagePath);
  if (!obj) throw errors.invalid('Upload not found — upload it first', { field: 'storagePath' });
  if (obj.size > MEMORY_UPLOAD_MAX_BYTES)
    throw errors.too_large('A memory file is limited to 1 GB', { size: obj.size });
  const dim = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const width = dim(obj.metadata?.width);
  const height = dim(obj.metadata?.height);
  return putVersion(
    ctx,
    memoryId,
    input,
    {
      fileId: p.fileId,
      storagePath,
      mime: obj.contentType || 'application/octet-stream',
      size: obj.size,
      ...(width && height ? { width, height } : {}),
    },
    input.expectedFileId,
  );
});
