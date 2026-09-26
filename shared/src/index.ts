/**
 * @tm/shared — every shape the system exchanges, defined once.
 *
 *   types/     primitive + shared zod schemas (Uid, Stage, FieldDef, FilterNode, Scope …)
 *   schema/    stored documents (Firestore, RTDB, search index) + DOC_SCHEMAS
 *   paths      Firestore / RTDB / Storage path builders
 *   rtdb       the LIVE tree (§W): heartbeat status, board revision, agent wake
 *   errors     AppError codes → HTTP, RFC 9457 problem+json
 *   commands/  COMMANDS registry: Req / Res zod per /api command, CommandCtx
 *   api/       public (toPublic) shapes, /v1 REST, MCP tools, intake, webhooks
 *   ports/     adapter interfaces (email, push, WhatsApp, search, queue …)
 *
 * Fixtures live at '@tm/shared/schema/fixtures' (not re-exported here).
 *   logic/     pure logic (can, rank, view engine, rich text, quick add, time) — also
 *              importable on its own as '@tm/shared/logic/index'
 */
export * from './types/index.js';
export * from './schema/index.js';
export * from './paths.js';
export * from './rtdb.js';
export * from './errors.js';
export * from './commands/index.js';
export * from './api/index.js';
export * from './ports/index.js';
export * from './logic/index.js';
