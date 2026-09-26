/**
 * THE TipTap schema — one extension list for the editor (frontend) and the
 * validator (backend). The ProseMirror schema both sides use is built from
 * exactly this list (schema.ts: `getSchema(richTextExtensions())`), so a doc
 * the editor can produce is a doc the server accepts, and nothing else is.
 *
 *   nodes  doc, paragraph, text, hardBreak, heading (1–3), blockquote,
 *          bulletList, orderedList, listItem, taskList, taskItem, codeBlock,
 *          horizontalRule, mention { uid }, ticketRef { ticketId, key }
 *   marks  bold, italic, strike, underline, code, link (http/https/mailto only)
 *
 * No images (attachments are separate), no tables, no raw HTML — ever.
 *
 * The editor imports `richTextExtensions({ mention, ticketRef })` and adds its
 * own UI-only extensions (Placeholder …) on top; those must not add nodes or marks.
 */
import { mergeAttributes, type AnyExtension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Mention from '@tiptap/extension-mention';
import StarterKit from '@tiptap/starter-kit';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import type { SuggestionOptions } from '@tiptap/suggestion';

export const LINK_PROTOCOLS = ['http', 'https', 'mailto'] as const;
export const HEADING_LEVELS = [1, 2, 3] as const;

/** Is this href one a link mark may carry? */
export function isAllowedHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return false;
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

type Suggestion = Omit<SuggestionOptions, 'editor'>;

export interface RichTextExtensionOptions {
  /** '@' picker (frontend). Items are inserted as { uid } (or { id }, mapped to uid). */
  mentionSuggestion?: Partial<Suggestion>;
  /** '#' picker (frontend). Items are inserted as { ticketId, key }. */
  ticketSuggestion?: Partial<Suggestion>;
  /** Current display name for a uid — a mention stores the uid and RENDERS the name. */
  nameOf?: (uid: string) => string | undefined;
  /** Current key for a ticket id (the stored key is only a hint). */
  keyOf?: (ticketId: string) => string | undefined;
}

const attr = (name: string, dataName: string) => ({
  [name]: {
    default: null,
    parseHTML: (el: { getAttribute(n: string): string | null }) => el.getAttribute(dataName),
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs[name] == null ? {} : { [dataName]: attrs[name] },
  },
});

/** mention { uid } — renders '@<current name>'. */
function mentionNode(opts: RichTextExtensionOptions) {
  const label = (uid: string) => `@${opts.nameOf?.(uid) ?? 'someone'}`;
  return Mention.extend({
    addAttributes: () => ({ ...attr('uid', 'data-uid') }),
    parseHTML: () => [{ tag: 'span[data-type="mention"]' }],
  }).configure({
    renderText: ({ node }) => label(String(node.attrs.uid)),
    renderHTML: ({ node, options }) => [
      'span',
      mergeAttributes({ 'data-type': 'mention', class: 'mention' }, options.HTMLAttributes, {
        'data-uid': node.attrs.uid,
      }),
      label(String(node.attrs.uid)),
    ],
    suggestion: {
      char: '@',
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: 'mention',
              attrs: {
                uid: (props as { uid?: string; id?: string }).uid ?? (props as { id?: string }).id,
              },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      ...opts.mentionSuggestion,
    },
  });
}

/** ticketRef { ticketId, key } — renders '#ENG-42'. */
function ticketRefNode(opts: RichTextExtensionOptions) {
  const label = (ticketId: string, key: unknown) =>
    `#${opts.keyOf?.(ticketId) ?? (typeof key === 'string' && key ? key : 'ticket')}`;
  return Mention.extend({
    name: 'ticketRef',
    addAttributes: () => ({ ...attr('ticketId', 'data-ticket-id'), ...attr('key', 'data-key') }),
    parseHTML: () => [{ tag: 'span[data-type="ticketRef"]' }],
  }).configure({
    renderText: ({ node }) => label(String(node.attrs.ticketId), node.attrs.key),
    renderHTML: ({ node, options }) => [
      'span',
      mergeAttributes({ 'data-type': 'ticketRef', class: 'ticket-ref' }, options.HTMLAttributes, {
        'data-ticket-id': node.attrs.ticketId,
        'data-key': node.attrs.key,
      }),
      label(String(node.attrs.ticketId), node.attrs.key),
    ],
    suggestion: {
      char: '#',
      // A distinct plugin key: two Mention-derived nodes must not share the default one.
      pluginKey: new PluginKey('ticketRef'),
      command: ({ editor, range, props }) => {
        const p = props as { ticketId?: string; id?: string; key?: string };
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: 'ticketRef', attrs: { ticketId: p.ticketId ?? p.id, key: p.key ?? null } },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      ...opts.ticketSuggestion,
    },
  });
}

/** The whole allow-list, as TipTap extensions. */
export function richTextExtensions(opts: RichTextExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [...HEADING_LEVELS] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: [...LINK_PROTOCOLS],
        isAllowedUri: (url) => isAllowedHref(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    mentionNode(opts),
    ticketRefNode(opts),
  ];
}
