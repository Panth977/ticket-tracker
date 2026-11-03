<!--
  The board script's code editor (docs/plan/board-script.html §editor): Monaco,
  the editor of VS Code, with the script's API as types (BOARD_SCRIPT_DTS) —
  completion for every hook's arguments, `ui.*`, `h.*`, `dates.*` and `api.*`,
  hover docs, errors as you type (checkJs), a snippet per hook (type its name),
  Format (⇧⌥F) and ⌘/Ctrl+S to save. If Monaco cannot load (offline), the plain
  code box stands in.
-->
<script lang="ts" module>
  export interface ScriptProblem {
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
  }
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BOARD_SCRIPT_DTS } from '@tm/shared';
  import { isDarkTheme } from '$lib/bucket/codemirror';
  import CodeField from '../CodeField.svelte';
  import { loadMonaco, type Monaco } from './monaco';
  import { HOOK_SNIPPETS } from './snippets';

  interface Props {
    value: string;
    readOnly?: boolean;
    onchange: (code: string) => void;
    onsave?: () => void;
    onproblems?: (p: ScriptProblem[]) => void;
    class?: string;
  }
  let { value, readOnly = false, onchange, onsave, onproblems, class: cls = '' }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  let failed = $state(false);
  let loading = $state(true);
  let monaco: Monaco = null;
  let editor: Monaco = null;
  let model: Monaco = null;
  const disposers: { dispose(): void }[] = [];
  let echo = false;

  /** Once per page: the script's types and the hook snippets. */
  const g = globalThis as unknown as { __tmBoardScriptLang?: boolean };
  function setupLanguage(m: Monaco) {
    const ts = m.typescript ?? m.languages.typescript;
    const js = ts?.javascriptDefaults;
    // The artifact Code tab turns Monaco's own TypeScript off for its engine; turn it on here.
    js?.setModeConfiguration?.({
      completionItems: true,
      hovers: true,
      documentSymbols: true,
      definitions: true,
      references: true,
      documentHighlights: true,
      rename: true,
      diagnostics: true,
      documentRangeFormattingEdits: true,
      signatureHelp: true,
      onTypeFormattingEdits: true,
      codeActions: true,
      inlayHints: true,
    });
    if (g.__tmBoardScriptLang) return;
    g.__tmBoardScriptLang = true;
    js?.setCompilerOptions({
      target: ts.ScriptTarget?.ES2022 ?? 9,
      module: ts.ModuleKind?.ESNext ?? 99,
      allowJs: true,
      checkJs: true,
      allowNonTsExtensions: true,
      noLib: false,
      lib: ['es2022'],
    });
    js?.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
    js?.addExtraLib(BOARD_SCRIPT_DTS, 'file:///board-script.d.ts');
    m.languages.registerCompletionItemProvider('javascript', {
      provideCompletionItems: (mod: Monaco, pos: Monaco) => {
        const word = mod.getWordUntilPosition(pos);
        const range = {
          startLineNumber: pos.lineNumber,
          endLineNumber: pos.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: HOOK_SNIPPETS.map((s) => ({
            label: s.label,
            kind: m.languages.CompletionItemKind.Snippet,
            detail: s.detail,
            documentation: s.doc,
            insertText: s.body,
            insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    });
  }

  onMount(() => {
    let gone = false;
    void loadMonaco()
      .then((m) => {
        if (gone || !host) return;
        monaco = m;
        setupLanguage(m);
        const uri = m.Uri.parse(`file:///board-script-${Math.random().toString(36).slice(2)}.js`);
        model = m.editor.createModel(value, 'javascript', uri);
        editor = m.editor.create(host, {
          model,
          theme: isDarkTheme() ? 'vs-dark' : 'vs',
          automaticLayout: true,
          readOnly,
          fontSize: 13,
          lineHeight: 20,
          // The app's mono stack (Monaco's own default measures wrong under the app's CSS).
          fontFamily:
            getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
            "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
          fontLigatures: false,
          minimap: { enabled: true, scale: 1, renderCharacters: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          fixedOverflowWidgets: true,
          smoothScrolling: true,
          padding: { top: 8 },
          folding: true,
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          stickyScroll: { enabled: true },
          suggest: { showStatusBar: true, preview: true },
          quickSuggestions: { other: true, comments: false, strings: true },
          inlayHints: { enabled: 'on' },
        });
        disposers.push(
          model.onDidChangeContent(() => {
            if (echo) return;
            onchange(model.getValue());
          }),
          m.editor.onDidChangeMarkers((uris: Monaco[]) => {
            if (!uris.some((u: Monaco) => u.toString() === uri.toString())) return;
            const list = m.editor.getModelMarkers({ resource: uri });
            onproblems?.(
              list
                .filter((x: Monaco) => x.severity >= m.MarkerSeverity.Warning)
                .map((x: Monaco) => ({
                  line: x.startLineNumber,
                  column: x.startColumn,
                  message: x.message,
                  severity: x.severity >= m.MarkerSeverity.Error ? 'error' : 'warning',
                })),
            );
          }),
        );
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => onsave?.());
        // Glyph widths are measured once; measure again when the page's fonts have loaded.
        void document.fonts?.ready.then(() => m.editor.remeasureFonts());
        loading = false;
      })
      .catch(() => {
        failed = true;
        loading = false;
      });
    return () => {
      gone = true;
    };
  });
  onDestroy(() => {
    for (const d of disposers) d.dispose();
    editor?.dispose();
    model?.dispose();
  });

  // Outside changes (Default / From settings, the saved script arriving) — never echo our own typing.
  $effect(() => {
    const v = value;
    if (!model || model.getValue() === v) return;
    echo = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: v }], () => null);
    echo = false;
  });
  $effect(() => {
    editor?.updateOptions({ readOnly });
  });

  /** Put the caret on a line (a problem's line is a button). */
  export function jump(line: number, column = 1) {
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }
  /** Format the whole script (also ⇧⌥F in the editor). */
  export function format() {
    void editor?.getAction('editor.action.formatDocument')?.run();
  }
  export const ready = () => !!editor;
</script>

{#if failed}
  <CodeField {value} {readOnly} {onchange} {onsave} class={cls} />
{:else}
  <div
    class="relative overflow-hidden rounded-md border border-line bg-surface {cls}"
    data-testid="script-editor"
  >
    {#if loading}<p class="absolute inset-0 p-3 text-xs text-muted">Loading the editor…</p>{/if}
    <div bind:this={host} class="h-full" data-monaco></div>
  </div>
{/if}
