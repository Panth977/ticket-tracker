/**
 * memoryFileWrite (memory.html §G) — create or replace a file INLINE: text or
 * base64, ≤ MEMORY_INLINE_MAX_BYTES. The API, MCP, the driver and the app's
 * code mode all save through here. A new version is a new object (D-M2);
 * `expectedFileId` makes the save conditional (409 'stale').
 */
import { errors } from '@tm/shared';
import { putVersion, targetName, writeBytes } from '../memory/files.js';
import { loadMemory } from '../memory/shared.js';
import { uploadBytes } from '../platform/uploads.js';
import { defineCommand } from './_registry.js';

export default defineCommand('memoryFileWrite', async (ctx, input) => {
  const { memoryId } = input;
  // Refuse early, before any bytes are stored.
  await loadMemory(null, memoryId, ctx, 'write');
  const name = await targetName(memoryId, input);
  let bytes: Uint8Array;
  try {
    bytes = uploadBytes({ text: input.text, content_base64: input.content_base64 });
  } catch (e) {
    throw errors.invalid((e as Error).message, { field: 'content_base64' });
  }
  const file = await writeBytes(ctx, memoryId, name, bytes, input.mime);
  return putVersion(ctx, memoryId, input, file, input.expectedFileId);
});
