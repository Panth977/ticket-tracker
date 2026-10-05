/**
 * Pure logic both sides must agree on — no I/O, no clocks (callers pass `now`).
 *
 *   can        may this actor do this to this board?          (backend.json proxyFunctions.can)
 *   rank       fractional ordering inside a column             (proxyFunctions.rank)
 *   view       applyView: filter tree, sort, group, swimlanes
 *   richtext   THE TipTap schema, validateDoc, derive, parseRichText, Markdown ↔ doc
 *   diff       what changed, for activity and notification copy (proxyFunctions.diff)
 *   quickAdd   'Fix login @pri !high due:fri #ENG-40 +bug'
 *   time       zone-aware day / week, dueSoon, overdue, quiet hours, parseDue
 *   validators board / ticket keys
 *   files      fileKind / fileInfo: how to open a file (viewer + API), sandbox, limits
 *   stages     orderedStages / firstStage: where a ticket with no stage lands (§Q3)
 */
export * from './can.js';
export * from './rank.js';
export * from './view.js';
export * from './richtext/index.js';
export * from './diff.js';
export * from './quickAdd.js';
export * from './time.js';
export * from './validators.js';
export * from './files.js';
export * from './question.js';
export * from './stages.js';
export * from './description.js';
