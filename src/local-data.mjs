import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { attach } from './attachments.mjs';
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
    const part = (await attach(root, file.path, {})).parts[0].text;
    const lines = part.split('\n');
    return { rows: lines.slice(offset, offset + count), ...(offset + count < lines.length ? { nextOffset: offset + count } : {}) };
  }
  if (!['.docx', '.xlsx', '.csv', '.tsv'].includes(kind)) throw new Error('Use DOCX, XLSX, CSV, TSV or PDF.');
  if (file.info.size > 64 * 1024 * 1024) throw new Error('Document exceeds the 64 MiB source limit.');
  const part = options.part ?? 'all';
  if (!['all', 'tables', 'paragraphs'].includes(part)) throw new Error('Use all, tables or paragraphs.');
  const [binary, ...prefix] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  const script = fileURLToPath(new URL('./document_extract.py', import.meta.url));
  try {
    const { stdout } = await exec(binary, [...prefix, script, file.path, part, options.sheet ?? '', String(offset), String(count)],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Python 3 to extract this local document.');
    throw new Error('Could not extract the selected sections. Check the worksheet name or file access.');
  }
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
    if (action !== 'table' || !tables.some(item => item.name === table)) throw new Error('Choose a table listed by xcode db <file> list.');
    const limit = Number(options.rows ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Select 1–200 rows.');
    const quote = name => '"' + name.replaceAll('"', '""') + '"';
    const where = options.where?.split(/=(.*)/s);
    const fields = database.prepare('PRAGMA table_info(' + quote(table) + ')').all().slice(0, 80);
    if (!fields.length) throw new Error('No readable columns in this table.');
    if (where && (!fields.some(field => field.name === where[0]) || where.length < 2)) throw new Error('Use --where column=value.');
    const selections = fields.map(field => {
      const col = quote(field.name);
      return "CASE typeof(" + col + ") WHEN 'blob' THEN ('[binary ' || length(" + col + ") || ' bytes]') " +
        "WHEN 'text' THEN substr(" + col + ",1,4000) ELSE " + col + " END AS " + col;
    });
    const filter = where ? ' WHERE ' + quote(where[0]) + ' = ?' : '';
    const statement = database.prepare('SELECT ' + selections.join(',') + ' FROM ' + quote(table) + filter + ' LIMIT ?');
    statement.setReadBigInts(true);
    const rows = statement.all(...(where ? [where[1]] : []), limit).map(row =>
      Object.fromEntries(Object.entries(row).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() :
        value instanceof Uint8Array ? { binaryBytes: value.byteLength } : typeof value === 'string' ? value.slice(0, 4000) : value])));
    return { table, rows };
  } finally {
    database.close();
  }
}
