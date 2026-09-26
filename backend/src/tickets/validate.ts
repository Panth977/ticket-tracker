/**
 * Validating what a ticket command names against the BOARD it is on: stages,
 * priorities, tags, custom-field values, people. zod already checked the
 * shapes; this checks that the ids exist here. Unknown ids are a 400 naming
 * them; a stage whose `requires` is unmet is a 422 { missing } so the UI can
 * open a small form for exactly those fields.
 */
import {
  DateRangeSchema,
  errors,
  type BoardWithId,
  type FieldDef,
  type FieldValue,
  type Stage,
} from '@tm/shared';

export function findStage(board: BoardWithId, stageId: string): Stage {
  const s = board.stages.find((x) => x.id === stageId);
  if (!s)
    throw errors.invalid(`Unknown stage "${stageId}" on this board`, { field: 'stageId', stageId });
  return s;
}

/** The first stage of category 'todo' (by position), else the first stage. */
export function defaultStage(board: BoardWithId): Stage {
  const sorted = [...board.stages].sort((a, b) => a.position - b.position);
  return sorted.find((s) => s.category === 'todo') ?? sorted[0]!;
}

export function checkPriority(board: BoardWithId, priorityId: string | null | undefined): void {
  if (priorityId == null) return;
  if (!board.priorities.some((p) => p.id === priorityId))
    throw errors.invalid(`Unknown priority "${priorityId}"`, { field: 'priorityId', priorityId });
}

/** De-duplicated tag ids, each on the board. */
export function checkTags(board: BoardWithId, tagIds: readonly string[]): string[] {
  const out = [...new Set(tagIds)];
  const unknown = out.filter((t) => !board.tags.some((x) => x.id === t));
  if (unknown.length) throw errors.invalid('Unknown tags', { field: 'tagIds', tagIds: unknown });
  return out;
}

export const isMember = (board: Pick<BoardWithId, 'access'>, uid: string): boolean =>
  Object.prototype.hasOwnProperty.call(board.access, uid);

/** De-duplicated uids, each with a role on this board — else 400 naming the others. */
export function checkMembers(board: BoardWithId, uids: readonly string[], field: string): string[] {
  const out = [...new Set(uids)];
  const notMembers = out.filter((u) => !isMember(board, u));
  if (notMembers.length)
    throw errors.invalid(`Not on this board: ${notMembers.join(', ')}`, {
      field,
      uids: notMembers,
    });
  return out;
}

/** 'Not set': absent, null, '', [] (a false checkbox IS set). */
export function isEmptyValue(v: FieldValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function fieldDef(board: BoardWithId, fieldId: string): FieldDef {
  const def = board.fields.find((f) => f.id === fieldId);
  if (!def) throw errors.invalid(`Unknown field "${fieldId}"`, { field: `fields.${fieldId}` });
  return def;
}

/**
 * Is `value` right for this field? null always clears. Throws 400 naming the
 * field. Formula fields are computed on the server and never written.
 */
export function checkFieldValue(
  board: BoardWithId,
  fieldId: string,
  value: FieldValue,
): FieldValue {
  const def = fieldDef(board, fieldId);
  const bad = (why: string) =>
    errors.invalid(`Field "${def.name}": ${why}`, { field: `fields.${fieldId}` });
  if (def.type === 'formula') throw bad('computed, read-only');
  if (value === null) return null;
  const optionIds = new Set((def.options ?? []).map((o) => o.id));
  switch (def.type) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
      if (typeof value !== 'string') throw bad('expected text');
      if (value.length > 10_000) throw bad('too long');
      return value;
    case 'number':
    case 'currency':
    case 'percent':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('expected a number');
      return value;
    case 'rating': {
      const max = def.config?.max ?? 5;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
        throw bad(`expected a whole number 0–${max}`);
      return value;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') throw bad('expected true or false');
      return value;
    case 'select':
      if (typeof value !== 'string' || !optionIds.has(value)) throw bad('unknown option');
      return value;
    case 'multiSelect':
      if (!Array.isArray(value) || value.some((v) => !optionIds.has(v)))
        throw bad('unknown option');
      return [...new Set(value)];
    case 'date':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        throw bad('expected a date');
      return value;
    case 'dateRange': {
      const r = DateRangeSchema.safeParse(value);
      if (!r.success || r.data.end < r.data.start) throw bad('expected { start, end }');
      return r.data;
    }
    case 'person':
      if (typeof value !== 'string' || !isMember(board, value))
        throw bad('not a person on this board');
      return value;
    case 'people':
      if (!Array.isArray(value) || value.some((u) => !isMember(board, u)))
        throw bad('not people on this board');
      return [...new Set(value)];
    case 'ticketRelation':
      if (!Array.isArray(value)) throw bad('expected ticket ids');
      return [...new Set(value)];
  }
}

/** Validate a whole `fields` patch; returns the cleaned values. */
export function checkFields(
  board: BoardWithId,
  fields: Record<string, FieldValue>,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [id, v] of Object.entries(fields)) out[id] = checkFieldValue(board, id, v);
  return out;
}

/** Required (non-archived) fields with no value in `fields`. */
export function missingRequired(board: BoardWithId, fields: Record<string, FieldValue>): string[] {
  return board.fields
    .filter((f) => f.required && !f.archived && isEmptyValue(fields[f.id]))
    .map((f) => f.id);
}

/** Field ids a stage `requires` to be entered that are not set. */
export function missingForStage(stage: Stage, fields: Record<string, FieldValue>): string[] {
  return (stage.requires ?? []).filter((id) => isEmptyValue(fields[id]));
}

/** 422 when a stage's requirements are unmet. */
export function requireStageFields(stage: Stage, fields: Record<string, FieldValue>): void {
  const missing = missingForStage(stage, fields);
  if (missing.length)
    throw errors.unprocessable(`"${stage.name}" needs these fields first`, {
      missing,
      stageId: stage.id,
    });
}
