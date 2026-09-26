/**
 * The editor's extension list: THE shared schema (shared logic/richtext
 * `richTextExtensions`) with the pickers wired in, plus UI-only extensions
 * that add NO nodes or marks (placeholder, slash commands, ⌘↵ submit), so
 * whatever the editor produces is what the server accepts.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Placeholder } from '@tiptap/extensions';
import Suggestion from '@tiptap/suggestion';
import { richTextExtensions } from '@tm/shared/logic/index';
import { matchSlash, SLASH_COMMANDS } from './doc';
import { suggestionRenderer, type SuggestItem } from './suggest.svelte';

export interface EditorOptions {
  placeholder?: string;
  /** '@' items for a query (people on the board). Omit to disable the picker. */
  people?: (query: string) => SuggestItem[] | Promise<SuggestItem[]>;
  /** '#' items for a query (ticket search). */
  tickets?: (query: string) => SuggestItem[] | Promise<SuggestItem[]>;
  /** Enable '/' commands at the start of a line. */
  slash?: boolean;
  /** ⌘↵ / Ctrl+↵. Return true when handled. */
  onSubmit?: () => boolean;
  /** Escape with no picker open. */
  onEscape?: () => boolean;
  nameOf?: (uid: string) => string | undefined;
  keyOf?: (ticketId: string) => string | undefined;
}

/** '/' at the start of a line → the command list; picking one leaves '/cmd ' to type the argument after. */
const SlashCommands = Extension.create({
  name: 'slashCommands',
  addProseMirrorPlugins() {
    return [
      Suggestion<SuggestItem, SuggestItem>({
        editor: this.editor,
        char: '/',
        startOfLine: true,
        pluginKey: new PluginKey('slashCommands'),
        items: ({ query }) =>
          matchSlash(query).map((c) => ({
            id: c.id,
            kind: 'command' as const,
            label: c.label,
            detail: c.hint,
          })),
        command: ({ editor, range, props }) => {
          const cmd = SLASH_COMMANDS.find((c) => c.id === props.id);
          editor
            .chain()
            .focus()
            .insertContentAt(range, cmd?.needsArg ? `${props.label} ` : props.label)
            .run();
          // '/assign ' → open the people picker straight away.
          if (props.id === 'assign' || props.id === 'unassign')
            editor.chain().insertContent('@').run();
        },
        render: suggestionRenderer('Commands', 'No such command'),
      }),
    ];
  },
});

function keys(opts: EditorOptions) {
  return Extension.create({
    name: 'composerKeys',
    addKeyboardShortcuts() {
      return {
        'Mod-Enter': () => opts.onSubmit?.() ?? false,
        Escape: () => opts.onEscape?.() ?? false,
      };
    },
  });
}

export function editorExtensions(opts: EditorOptions): AnyExtension[] {
  const off = { items: () => [], allow: () => false };
  const list: AnyExtension[] = [
    ...richTextExtensions({
      nameOf: opts.nameOf,
      keyOf: opts.keyOf,
      mentionSuggestion: opts.people
        ? {
            items: ({ query }) => opts.people!(query),
            render: suggestionRenderer('People', 'Nobody on this board matches'),
          }
        : off,
      ticketSuggestion: opts.tickets
        ? {
            items: ({ query }) => opts.tickets!(query),
            render: suggestionRenderer('Tickets', 'No matching tickets'),
          }
        : off,
    }),
    keys(opts),
  ];
  if (opts.placeholder) list.push(Placeholder.configure({ placeholder: opts.placeholder }));
  if (opts.slash) list.push(SlashCommands);
  return list;
}

/** Is a picker (suggestion popup) open in this editor right now? */
export function pickerOpen(editor: Editor | null | undefined): boolean {
  return !!editor && !!editor.view.dom.ownerDocument.querySelector('[role=listbox][aria-label]');
}
