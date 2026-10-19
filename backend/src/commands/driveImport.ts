/**
 * driveImport (bucket.html §L7) — make a board, dictionary, bucket or artifact
 * kept in a Drive folder (by this or another TaskManager) an entity here again.
 */
import { importFromDrive } from '../db/drive/importer.js';
import { defineCommand } from './_registry.js';

export default defineCommand('driveImport', async (ctx, input) => importFromDrive(ctx, input));
