<!--
  The template editor's code box: CodeMirror (the bucket's Code mode editor,
  lib/bucket/codemirror), loaded on first use. `jump(line)` puts the caret on
  a line — a problem's "line 12" is a button.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { createCodeEditor, isDarkTheme, type CodeEditor } from '$lib/bucket/codemirror';

  interface Props {
    value: string;
    readOnly?: boolean;
    onchange: (code: string) => void;
    onsave?: () => void;
    class?: string;
  }
  let { value, readOnly = false, onchange, onsave, class: cls = '' }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let ed = $state.raw<CodeEditor | null>(null);
  let loading = $state(true);

  onMount(() => {
    let gone = false;
    void createCodeEditor({
      parent: host!,
      text: value,
      name: 'template.js',
      readOnly,
      dark: isDarkTheme(),
      onChange: (t) => onchange(t),
      onSave: () => onsave?.(),
    }).then((e) => {
      if (gone) return e.destroy();
      // The draft may have been filled in while CodeMirror loaded.
      if (e.getText() !== value) e.setText(value);
      ed = e;
      loading = false;
    });
    return () => {
      gone = true;
    };
  });
  onDestroy(() => ed?.destroy());

  $effect(() => {
    // Outside changes (a reset, a fresh template) — never echo our own typing.
    const v = value;
    if (ed && ed.getText() !== v) ed.setText(v);
  });
  $effect(() => ed?.setReadOnly(readOnly));

  export function jump(line: number) {
    if (!ed) return;
    const doc = ed.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(doc.lines, line)));
    ed.view.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
    ed.focus();
  }
</script>

<div
  class="relative overflow-hidden rounded-md border border-line bg-surface {cls}"
  data-testid="template-code"
>
  {#if loading}<p class="absolute inset-0 p-3 text-xs text-muted">Loading the editor…</p>{/if}
  <div bind:this={host} class="h-full"></div>
</div>
