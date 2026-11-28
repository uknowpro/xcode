import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { verifiedFile } from './workspace.mjs';

const exec = promisify(execFile);

export async function extractDocument(root, path, options) {
  const file = await verifiedFile(root, path);
  const kind = extname(file.path).toLowerCase();
  const offset = Number(options.offset ?? 0);
  const count = Number(options.rows ?? 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 50000 || !Number.isInteger(count) || count < 1 || count > 60)
    throw new Error('Choose up to 60 rows or paragraphs and a valid offset.');
  if (kind === '.pdf') {
    const requested = Number(options.page ?? 1);
    if (!Number.isInteger(requested) || requested < 1 || requested > 10000) throw new Error('Choose a positive PDF page number.');
    const end = options.page === undefined ? requested + 24 : requested;
    let text;
    try {
      ({ stdout: text } = await exec('pdftotext', ['-layout', '-f', String(requested), '-l', String(end), file.path, '-'],
        { encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true }));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Install pdftotext to extract PDF text.');
      throw new Error('The PDF text is unavailable. Check the PDF or open it in an authorized application.');
    }
    let lines;
    if (options.part === 'tables') {
      lines = text.split('\n').map(row => row.trim().split(/[ \t]{2,}/)).filter(row => row.length > 1);
    } else if (options.part === 'paragraphs') lines = text.split(/\n[ \t]*\n|\f/).map(row => row.trim()).filter(Boolean);
    else lines = text.split('\n');
    return { rows: lines.slice(offset, offset + count), page: requested,
      ...(offset + count < lines.length ? { nextOffset: offset + count } : {}) };
  }
  if (!['.docx', '.xlsx', '.csv', '.tsv'].includes(kind)) throw new Error('Use DOCX, XLSX, CSV, TSV or PDF.');
  if (file.info.size > 64 * 1024 * 1024) throw new Error('Document exceeds the 64 MiB source limit.');
  const part = options.part ?? 'all';
  if (!['all', 'tables', 'paragraphs'].includes(part)) throw new Error('Use all, tables or paragraphs.');
  const [binary, ...prefix] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  const script = fileURLToPath(new URL('./document_extract.py', import.meta.url));
  try {
    const { stdout } = await exec(binary, [...prefix, script, file.path, part, options.sheet ?? '', String(offset), String(count),
      options.heading ?? '', options.table ?? '', options.range ?? '', options.outline ? '1' : '0'],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Python 3 to extract this local document.');
    throw new Error('Could not extract the selected sections. Check the worksheet name or file access.');
  }
}

export async function compareDocuments(root, left, right, options) {
  const before = await extractDocument(root, left, options);
  const after = await extractDocument(root, right, options);
  const offset = Number(options.offset ?? 0);
  const changes = [];
  for (let i = 0; i < Math.max(before.rows.length, after.rows.length); i++) {
    const a = before.rows[i] ?? null, b = after.rows[i] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ row: offset + i + 1, before: a, after: b });
  }
  return { changes, ...(before.nextOffset || after.nextOffset ? { nextOffset: before.nextOffset ?? after.nextOffset } : {}) };
}

export function csvRows(rows, columns) {
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return [columns.map(quote).join(','), ...rows.map(row => columns.map(key => quote(row[key])).join(','))].join('\n');
}

export async function queryLocalDatabase(root, path, action, table, options) {
  const file = await verifiedFile(root, path);
  const { DatabaseSync } = await import('node:sqlite').catch(() => {
    throw new Error('This Node.js runtime does not provide SQLite support.');
  });
  const database = new DatabaseSync(file.path, { readOnly: true, allowExtension: false });
  try {
    database.exec('PRAGMA trusted_schema = OFF');
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 200").all();
    if (action === 'list' || !action) return { tables: tables.map(item => item.name) };
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    const schema = name => ({
      name, columns: database.prepare('PRAGMA table_info(' + quote(name) + ')').all(),
      foreignKeys: database.prepare('PRAGMA foreign_key_list(' + quote(name) + ')').all(),
    });
    if (action === 'schema') {
      if (table && !tables.some(item => item.name === table)) throw new Error('Unknown local table.');
      return { tables: table ? [schema(table)] : tables.map(item => schema(item.name)) };
    }
    if (action !== 'table' || !tables.some(item => item.name === table)) throw new Error('Choose a table listed by xcode db <file> list.');
    const limit = Number(options.rows ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Select 1–200 rows.');
    const offset = Number(options.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new Error('Invalid row offset.');
    const where = options.where?.split(/=(.*)/s);
    const all = schema(table).columns;
    const names = options.columns?.split(',').map(name => name.trim());
    if (names && (names.length > 80 || names.some(name => !all.some(item => item.name === name))))
      throw new Error('Use existing column names in --columns.');
    const fields = names ? names.map(name => all.find(item => item.name === name)) : all.slice(0, 80);
    if (!fields.length) throw new Error('No readable columns in this table.');
    if (where && (!all.some(field => field.name === where[0]) || where.length < 2)) throw new Error('Use --where column=value.');
    const selections = fields.map(field => {
      const col = quote(field.name);
      return "CASE typeof(" + col + ") WHEN 'blob' THEN ('[binary ' || length(" + col + ") || ' bytes]') " +
        "WHEN 'text' THEN substr(" + col + ",1,4000) ELSE " + col + " END AS " + col;
    });
    const filter = where ? ' WHERE ' + quote(where[0]) + ' = ?' : '';
    const [sort, direction = 'asc'] = options.order?.split(':') ?? [];
    if (sort && (!all.some(item => item.name === sort) || !['asc', 'desc'].includes(direction))) throw new Error('Use --order column:asc|desc.');
    const order = sort ? ' ORDER BY ' + quote(sort) + ' ' + direction : '';
    const statement = database.prepare('SELECT ' + selections.join(',') + ' FROM ' + quote(table) + filter + order + ' LIMIT ? OFFSET ?');
    statement.setReadBigInts(true);
    const rows = statement.all(...(where ? [where[1]] : []), limit + 1, offset).map(row =>
      Object.fromEntries(Object.entries(row).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() :
        value instanceof Uint8Array ? { binaryBytes: value.byteLength } : typeof value === 'string' ? value.slice(0, 4000) : value])));
    return { table, columns: fields.map(item => item.name), rows: rows.slice(0, limit),
      ...(rows.length > limit ? { nextOffset: offset + limit } : {}) };
  } finally {
    database.close();
  }
}
