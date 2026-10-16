/** A board's templates, live (boards/{b}/templates — readable by the board, templates.html §A). */
import { derived, type Readable } from 'svelte/store';
import { paths, type TemplateKind, type TemplateWithId } from '@tm/shared';
import { queryStore, type QueryState } from '$lib/stores';

export function boardTemplates(
  boardId: string | null | undefined,
): Readable<QueryState<TemplateWithId>> {
  return queryStore<TemplateWithId>(boardId ? { path: paths.templates(boardId) } : null);
}

/** Templates of one kind, in picker order. */
export function templatesOfKind(
  boardId: string | null | undefined,
  kind: TemplateKind,
): Readable<{ loading: boolean; list: TemplateWithId[] }> {
  return derived(boardTemplates(boardId), (s) => ({
    loading: s.loading,
    list: s.data
      .filter((t) => t.kind === kind)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
  }));
}
