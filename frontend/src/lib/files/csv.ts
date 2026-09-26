/**
 * A small RFC 4180 parser for the CSV viewer and card: quoted fields,
 * doubled quotes, newlines inside quotes, CRLF. TSV when the name says so or
 * the first line has tabs and no commas.
 */
export interface CsvTable {
  rows: string[][];
  /** Parsing stopped at maxRows. */
  truncated: boolean;
  delimiter: ',' | '\t' | ';';
}

export function detectDelimiter(text: string, name = ''): CsvTable['delimiter'] {
  if (/\.tsv$/i.test(name)) return '\t';
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const count = (c: string) => first.split(c).length - 1;
  const tabs = count('\t');
  const commas = count(',');
  const semis = count(';');
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

export function parseCsv(
  text: string,
  opts: { name?: string; maxRows?: number; delimiter?: CsvTable['delimiter'] } = {},
): CsvTable {
  const d = opts.delimiter ?? detectDelimiter(text, opts.name);
  const max = opts.maxRows ?? 5000;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  const n = src.length;
  const endRow = () => {
    row.push(field);
    field = '';
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= max) return { rows, truncated: i < n, delimiter: d };
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) endRow();
  return { rows, truncated: false, delimiter: d };
}
