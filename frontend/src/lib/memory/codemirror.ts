/**
 * CODE MODE's editor (docs/plan/memory.html §F) — CodeMirror 6, loaded only
 * when a file is opened in Code mode (a dynamic import, its own chunk), so
 * the app's first load does not carry an editor nobody asked for.
 */
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type LanguageId =
  | 'markdown'
  | 'javascript'
  | 'typescript'
  | 'jsx'
  | 'tsx'
  | 'json'
  | 'html'
  | 'css'
  | 'python'
  | 'yaml'
  | 'xml'
  | 'plain';

/** The language for a file name (pure — tested without loading CodeMirror). */
export function languageFor(name: string): LanguageId {
  const n = name.toLowerCase();
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'markdown';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'jsx':
      return 'jsx';
    case 'tsx':
      return 'tsx';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'html':
    case 'htm':
    case 'svelte':
    case 'vue':
      return 'html';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'py':
      return 'python';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'xml':
    case 'svg':
      return 'xml';
    default:
      return 'plain';
  }
}

async function languageExtension(id: LanguageId): Promise<Extension> {
  switch (id) {
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({
        jsx: true,
        typescript: true,
      });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml();
    default:
      return [];
  }
}

/** Is the app drawn dark right now (an explicit theme, or the system's)? */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export interface CodeEditor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  setDark(dark: boolean): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  destroy(): void;
}

export async function createCodeEditor(opts: {
  parent: HTMLElement;
  text: string;
  name: string;
  readOnly: boolean;
  dark: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}): Promise<CodeEditor> {
  const [{ basicSetup }, state, view, commands, oneDark, lang] = await Promise.all([
    import('codemirror'),
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/theme-one-dark'),
    languageExtension(languageFor(opts.name)),
  ]);
  const { EditorState, Compartment } = state;
  const { EditorView, keymap } = view;
  const theme = new Compartment();
  const ro = new Compartment();
  const base = EditorView.theme({
    '&': { height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
    '&.cm-focused': { outline: 'none' },
  });
  const ev = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.text,
      extensions: [
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              opts.onSave();
              return true;
            },
          },
          commands.indentWithTab,
        ]),
        basicSetup,
        lang,
        base,
        EditorView.lineWrapping,
        theme.of(opts.dark ? oneDark.oneDark : []),
        ro.of([EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view: ev,
    getText: () => ev.state.doc.toString(),
    setText: (text) => ev.dispatch({ changes: { from: 0, to: ev.state.doc.length, insert: text } }),
    setDark: (dark) => ev.dispatch({ effects: theme.reconfigure(dark ? oneDark.oneDark : []) }),
    setReadOnly: (readOnly) =>
      ev.dispatch({
        effects: ro.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      }),
    focus: () => ev.focus(),
    destroy: () => ev.destroy(),
  };
}
