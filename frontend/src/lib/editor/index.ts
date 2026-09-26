/**
 * Rich text for the app: the TipTap editor on THE shared schema, its pickers,
 * the read-only renderer, drafts and uploads.
 *
 *   <RichEditor value={doc} options={{ people, tickets, slash, onSubmit }} onchange={…} bind:editor />
 *   <EditorToolbar {editor} onattach={…} />
 *   <RichView doc={body.doc} ticketHref={(key) => …} />
 */
export { default as RichEditor } from './RichEditor.svelte';
export { default as RichView } from './RichView.svelte';
export { default as EditorToolbar } from './EditorToolbar.svelte';
export { editorExtensions, type EditorOptions } from './extensions';
export type { SuggestItem } from './suggest.svelte';
export * from './doc';
export * from './drafts';
export * from './upload';
export * from './ticketSearch';
// Phase 2 (agents.html §H): GitHub-flavoured Markdown, sanitised; highlighted code.
export { default as Markdown } from './Markdown.svelte';
export { default as Collapsible } from './Collapsible.svelte';
export { default as CodeBlock } from './CodeBlock.svelte';
export * from './markdown';
export { highlightCode, resolveLanguage, escapeHtml } from './highlight';
export { copyCode, copyText } from './copyCode';
