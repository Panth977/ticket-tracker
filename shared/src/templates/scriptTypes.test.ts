/**
 * The Script editor's types (BOARD_SCRIPT_DTS) describe the scripts the app writes:
 * the default script and a generated one type-check against them, as Monaco checks
 * them in the editor (checkJs, no DOM).
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BOARD_SCRIPT_DTS } from './scriptTypes.js';
import { DEFAULT_BOARD_SCRIPT, generateBoardScript } from './script.js';

function check(code: string): string[] {
  const files: Record<string, string> = {
    '/board-script.d.ts': BOARD_SCRIPT_DTS,
    '/script.js': code,
  };
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts'],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (f) => files[f] ?? read(f);
  host.fileExists = (f) => f in files || ts.sys.fileExists(f);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v) =>
    f in files ? ts.createSourceFile(f, files[f]!, v) : getSource(f, v);
  const program = ts.createProgram(['/board-script.d.ts', '/script.js'], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) =>
        `${d.file?.fileName}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    );
}

describe('BOARD_SCRIPT_DTS', () => {
  it('the default script type-checks', () => {
    expect(check(DEFAULT_BOARD_SCRIPT)).toEqual([]);
  });
  it('a generated script type-checks', () => {
    const code = generateBoardScript({
      priorities: [{ id: 'p1', name: 'High', color: 'red' }],
      tags: [{ id: 't1', name: 'bug' }],
      fields: [
        { id: 'f_c', name: 'Client', type: 'select', options: [{ id: 'o1', name: 'Acme' }] },
        { id: 'f_n', name: 'Points', type: 'number' },
        { id: 'f_p', name: 'Owner', type: 'person' },
      ],
    });
    expect(check(code)).toEqual([]);
  });
  it('a mistake is caught', () => {
    const bad = DEFAULT_BOARD_SCRIPT.replace("ui.toggle({ id: 'mine'", "ui.toggle({ idd: 'mine'");
    expect(check(bad).join('\n')).toMatch(/idd/);
  });
});
