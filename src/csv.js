import { parse } from 'csv-parse/sync';

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Guard against spreadsheet formula injection when opened in Excel.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';

/** Parse CSV text into an array of objects keyed by header. */
export function parseCsv(text) {
  return parse(text, {
    columns: (header) => header.map((h) => String(h).trim()),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
  });
}

/** Undo the formula-injection guard and decode JSON objects/arrays written by export. */
export function decodeCell(v) {
  if (typeof v !== 'string') return v;
  if (/^'[=+\-@]/.test(v)) return v.slice(1);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try { return JSON.parse(v); } catch { /* keep as string */ }
  }
  return v;
}
