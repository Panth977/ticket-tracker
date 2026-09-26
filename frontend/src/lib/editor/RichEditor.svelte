<!--
  A TipTap editor on THE shared schema.
  <RichEditor value={doc} options={{ placeholder, people, tickets, slash, onSubmit }}
              onchange={(d) => …} onfiles={(files) => …} bind:editor />
  `value` is read when the editor is created (and when `resetKey` changes);
  after that the editor owns its content and reports it through onchange.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Editor } from '@tiptap/core';
  import type { RichTextDoc } from '@tm/shared';
  import { editorExtensions, type EditorOptions } from './extensions';
  import './prose.css';

  interface Props {
    value?: RichTextDoc | null;
    options?: EditorOptions;
    editable?: boolean;
    autofocus?: boolean;
    /** Change it to re-seed the editor from `value` (e.g. a draft finished loading). */
    resetKey?: unknown;
    onchange?: (doc: RichTextDoc) => void;
    onfiles?: (files: File[]) => void;
    onfocus?: () => void;
    onblur?: () => void;
    editor?: Editor | null;
    label?: string;
    class?: string;
  }
  let {
    value = null,
    options = {},
    editable = true,
    autofocus = false,
    resetKey,
    onchange,
    onfiles,
    onfocus,
    onblur,
    editor = $bindable(null),
    label = 'Rich text editor',
    class: cls = '',
  }: Props = $props();

  let el: HTMLDivElement | undefined = $state();

  function filesFrom(dt: DataTransfer | null): File[] {
    return dt ? [...dt.files] : [];
  }

  function create(target: HTMLDivElement) {
    const content = value && value.content.length ? value : null;
    const e = new Editor({
      element: target,
      extensions: editorExtensions(options),
      content,
      editable,
      autofocus: autofocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'tm-prose outline-none',
          'aria-label': label,
          role: 'textbox',
          'aria-multiline': 'true',
        },
        handlePaste: (_view, event) => {
          const files = filesFrom(event.clipboardData);
          if (!files.length || !onfiles) return false;
          onfiles(files);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = filesFrom((event as DragEvent).dataTransfer);
          if (!files.length || !onfiles) return false;
          event.preventDefault();
          onfiles(files);
          return true;
        },
      },
      onUpdate: ({ editor: ed }) => onchange?.(ed.getJSON() as RichTextDoc),
      onFocus: () => onfocus?.(),
      onBlur: () => onblur?.(),
    });
    return e;
  }

  let seededFor: unknown = undefined;
  $effect(() => {
    if (!el) return;
    if (!editor) {
      editor = create(el);
      seededFor = resetKey;
    }
  });
  // Re-seed on resetKey change.
  $effect(() => {
    const k = resetKey;
    if (!editor || k === seededFor) return;
    seededFor = k;
    editor.commands.setContent(value && value.content.length ? value : '', { emitUpdate: false });
  });
  $effect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  });

  onDestroy(() => {
    editor?.destroy();
    editor = null;
  });

  export function focus() {
    editor?.commands.focus('end');
  }
</script>

<div bind:this={el} class="tm-editor min-w-0 {cls}"></div>
