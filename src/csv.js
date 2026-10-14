import { parse } from 'csv-parse/sync';

/*
 * Export and import share one encoding, kept friendly to spreadsheets:
 *   - numbers, true/false and JSON objects/arrays are written as their JSON text and read back
 *     with the same type (only the canonical form, so "007", "1.50" or "TRUE" stay text);
 *   - text a spreadsheet would run as a formula (starting =, +, -, @, tab or CR, other than a plain
 *     number such as -5) gets a leading apostrophe, and so does text that already starts with an
 *     apostrophe followed by one of those; import removes exactly that apostrophe. Any other
 *     leading apostrophe ("'s-Hertogenbosch") is ordinary text and is kept.
 *   - Text that merely looks like a number or true/false ("42", "true") is written plainly, so it
 *     opens as a number in Excel, and imports back as a number / boolean.
 * Header cells use the same formula guard. (Issue exports use the plain csvRow below.)
 */
const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
// Needs the apostrophe guard: a formula start (not a plain number), or an apostrophe that would
// itself be mistaken for a guard.
const needsGuard = (s) => (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) || /^'[=+\-@\t\r']/.test(s);
const isGuarded = (s) => /^'[=+\-@\t\r']/.test(s);

/** The typed value of an unguarded cell (number, boolean, object/array or the text itself). */
function typed(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) return n;
    return s;
  }
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch { /* keep as text */ }
  }
  return s;
}

/** Text form of one record value, before CSV quoting. */
export function encodeValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v !== 'string') return String(v);
  return needsGuard(v) ? "'" + v : v;
}

/** Header names are always text. */
export function encodeHeader(name) {
  const s = String(name);
  return needsGuard(s) ? "'" + s : s;
}

const quote = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
/** Record exports (/api/export.csv, history): typed values that import reads back unchanged. */
export const recordRow = (values) => values.map((v) => quote(encodeValue(v))).join(',') + '\r\n';
export const csvHeader = (names) => names.map((n) => quote(encodeHeader(n))).join(',') + '\r\n';

/** Plain text cells (issue exports): only the spreadsheet formula guard. */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) s = "'" + s;
  return quote(s);
}
export const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';

/** Undo the guard on a header name. */
export const decodeHeader = (h) => {
  const s = String(h).trim();
  return isGuarded(s) ? s.slice(1) : s;
};

/**
 * Parse CSV text into [{ row, line }]: `row` is keyed by the (decoded) header and `line` is the
 * line the row starts on in the file (quoted cells can span several lines, so it isn't simply
 * the row's index). Throws on duplicate header names instead of silently keeping one column.
 */
export function parseCsvRows(text, { maxColumns = Infinity } = {}) {
  // Check the header first: a file with a huge header (a million columns) would otherwise make every
  // row allocate that many cells while the whole file is parsed in one go, blocking the server.
  if (Number.isFinite(maxColumns)) {
    const head = parse(text.slice(0, 1024 * 1024), { bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, to: 1 });
    const n = head[0]?.length || 0;
    if (n > maxColumns) throw new Error(`Too many columns (${n}${text.length > 1024 * 1024 ? ' or more' : ''}). The most allowed is ${maxColumns}: the id plus the per-record field limit.`);
  }
  let width = Infinity;
  const records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: false,
    info: true,
    // Rows can't be much wider than the header: cells past it have no name and would be dropped
    // anyway, and a file of very wide rows would use a lot of memory. A few spare (trailing) cells are fine.
    on_record: (r) => {
      if (width === Infinity) { width = r.record.length; return r; }
      if (r.record.length > width + 10) throw new Error(`A row has ${r.record.length} cells but the header has ${width} columns`);
      if (r.record.length > width) r.record.length = width;
      return r;
    },
  });
  if (!records.length) return [];
  const names = records[0].record.map(decodeHeader);
  const seen = new Map();
  for (const n of names) {
    if (!n) continue;
    const key = n.toLowerCase() === 'id' ? 'id' : n; // id, ID and Id are all the id column
    if (seen.has(key)) throw new Error(`Duplicate column "${n}"${seen.get(key) !== n ? ` (same as "${seen.get(key)}")` : ''}. Each column name must appear once.`);
    seen.set(key, n);
  }
  // info.bytes is where each record (and its line break) ends, in bytes of the original text.
  const buf = Buffer.from(text, 'utf8');
  let pos = 0;
  let line = 1;
  const advance = (to) => { // count line breaks (CRLF, LF or CR) up to byte `to`
    for (; pos < to && pos < buf.length; pos++) {
      const c = buf[pos];
      if (c === 10 || (c === 13 && buf[pos + 1] !== 10)) line++;
    }
  };
  const out = [];
  out.names = names.filter(Boolean); // the header line (rows only carry the cells they have)
  for (let i = 1; i < records.length; i++) {
    advance(records[i - 1].info.bytes);
    while (pos < buf.length && (buf[pos] === 10 || buf[pos] === 13)) advance(pos + 1); // skipped empty lines
    const row = {};
    records[i].record.forEach((v, j) => { const n = names[j]; if (n && n !== '__proto__') row[n] = v; });
    out.push({ row, line });
  }
  return out;
}

/** Parse CSV text into an array of objects keyed by header. */
export const parseCsv = (text) => parseCsvRows(text).map((r) => r.row);

/** Undo the guard and restore the type that export wrote. */
export function decodeCell(v) {
  if (typeof v !== 'string') return v;
  if (isGuarded(v)) return v.slice(1);
  return typed(v);
}
/** Ids are always text: only undo the guard. */
export const decodeText = (v) => (typeof v === 'string' && isGuarded(v) ? v.slice(1) : v);
