#!/usr/bin/env node
'use strict';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlRows(rows) {
  return `<?xml version="1.0"?>\n<resultset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${rows
    .map(row => `<row>${Object.entries(row).map(([name, value]) =>
      value == null
        ? `<field name="${escapeXml(name)}" xsi:nil="true"/>`
        : `<field name="${escapeXml(name)}">${escapeXml(value)}</field>`
    ).join('')}</row>`)
    .join('')}</resultset>\n`;
}

function fail(args, category, message, exitCode) {
  process.stderr.write(`${JSON.stringify({
    version: 1,
    category,
    message,
    retryable: false,
    requestId: args['request-id'],
  })}\n`);
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
let sql = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  sql += chunk;
});
process.stdin.on('end', () => {
  if (process.argv.some(arg => arg.includes('stdin-only-marker'))) {
    fail(args, 'runner', 'SQL appeared in process arguments', 15);
    return;
  }
  if (args.profile === 'fail-relay') return fail(args, 'relay_login', 'Synthetic relay login failure', 10);
  if (args.profile === 'sql-error') return fail(args, 'sql_error', 'Synthetic SQL failure', 13);
  if (args.profile === 'large-stderr') {
    process.stderr.write('x'.repeat(4096));
    process.exit(15);
    return;
  }
  if (args.profile === 'large-stdout') {
    process.stdout.write('x'.repeat(4096));
    return;
  }
  if (args.profile === 'success-stderr') {
    process.stdout.write(xmlRows([{ ok: 1 }]));
    process.stderr.write('unexpected success diagnostics');
    return;
  }
  if (args.profile === 'error-stdout') {
    process.stdout.write(xmlRows([{ unexpected: 1 }]));
    fail(args, 'runner', 'Synthetic mixed-channel failure', 15);
    return;
  }
  if (args.profile === 'slow') {
    setTimeout(() => process.stdout.write(xmlRows([{ ok: 1 }])), 2000);
    return;
  }

  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  if (normalized.includes('SELECT VERSION()')) {
    process.stdout.write(xmlRows([{ version: '5.7.24-fixture' }]));
    return;
  }
  if (normalized.startsWith('SHOW DATABASES')) {
    process.stdout.write(xmlRows([{ Database: 'fixture_db' }, { Database: 'information_schema' }]));
    return;
  }
  if (normalized.includes('FROM INFORMATION_SCHEMA.TABLES')) {
    const columns = [
      ['id', 'bigint', 'bigint', 'NO', 'auto_increment', '1'],
      ['name', 'varchar', 'varchar(255)', 'YES', '', null],
      ...Array.from({ length: 12 }, (_, index) => [`wide_column_${index + 1}`, 'varchar', 'varchar(255)', 'YES', '', null]),
      ['right_edge', 'varchar', 'varchar(255)', 'YES', '', null],
    ];
    process.stdout.write(xmlRows(columns.map(([name, dataType, columnType, nullable, extra, pk], index) => ({
      object_name: 'wide_table', object_kind: 'BASE TABLE', object_comment: 'Synthetic wide table',
      column_name: name, ordinal_position: index + 1, data_type: dataType, column_type: columnType,
      is_nullable: nullable, extra, column_comment: '', primary_key_ordinal: pk,
    }))));
    return;
  }
  if (normalized.includes('COUNT(')) {
    process.stdout.write(xmlRows([{ count: 123 }]));
    return;
  }
  const manualSelect = sql.trim().match(
    /^SELECT\s+1\s+AS\s+`?([A-Za-z_][A-Za-z0-9_]*)`?(?:\s+LIMIT\s+5001)?\s*;?$/i
  );
  if (manualSelect) {
    process.stdout.write(xmlRows([{ [manualSelect[1]]: 1 }]));
    return;
  }
  if (normalized.includes('WIDE_TABLE')) {
    process.stdout.write(xmlRows(Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `fixture-row-${index + 1}`,
      ...Object.fromEntries(Array.from({ length: 12 }, (_unused, column) => [`wide_column_${column + 1}`, `value-${index + 1}-${column + 1}`])),
      right_edge: index === 0 ? 'right-edge-value' : `right-edge-${index + 1}`,
    }))));
    return;
  }
  if (sql.includes('stdin-only-marker')) {
    process.stdout.write(xmlRows([{ transport: 'stdin' }]));
    return;
  }
  process.stdout.write(xmlRows([{ ok: 1 }]));
});
