'use strict';

const { significantTokens, tokenUpper, tokenizeSql } = require('./sql-tokenizer');

function isIdentifier(token) {
  return token?.type === 'word' || token?.type === 'quoted_identifier';
}

function isSymbol(token, symbol) {
  return token?.type === 'symbol' && token.raw === symbol;
}

function identifierValue(token) {
  return isIdentifier(token) ? token.value : null;
}

function escapeIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function parseBaseTable(tokens) {
  const fromIndex = tokens.findIndex(token => token.depth === 0 && tokenUpper(token) === 'FROM');
  if (fromIndex < 0) return null;

  let index = fromIndex + 1;
  if (!isIdentifier(tokens[index])) return null;
  const parts = [identifierValue(tokens[index])];
  index += 1;
  while (isSymbol(tokens[index], '.') && isIdentifier(tokens[index + 1]) && parts.length < 3) {
    parts.push(identifierValue(tokens[index + 1]));
    index += 2;
  }

  if (tokenUpper(tokens[index]) === 'AS') index += 1;
  const alias = identifierValue(tokens[index]);
  if (!alias || alias.toUpperCase() !== 'BASETBL') return null;

  return {
    schemaName: parts.length > 1 ? parts[parts.length - 2] : null,
    pureName: parts[parts.length - 1],
  };
}

function snapshotTables(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot instanceof Map) return [...snapshot.values()];
  if (Array.isArray(snapshot.tables)) return snapshot.tables;
  if (Array.isArray(snapshot.structure?.tables)) return snapshot.structure.tables;
  if (Array.isArray(snapshot.databaseInfo?.tables)) return snapshot.databaseInfo.tables;
  if (snapshot.table) return [snapshot.table];
  return [];
}

function tablePureName(table) {
  return table?.pureName ?? table?.tableName ?? table?.name ?? null;
}

function tableSchemaName(table) {
  return table?.schemaName ?? table?.database ?? table?.databaseName ?? null;
}

function namesEqual(left, right) {
  return left != null && right != null && String(left).toLowerCase() === String(right).toLowerCase();
}

function findTable(snapshot, reference) {
  const byName = snapshotTables(snapshot).filter(table => namesEqual(tablePureName(table), reference.pureName));
  if (reference.schemaName) {
    const exactSchema = byName.find(table => namesEqual(tableSchemaName(table), reference.schemaName));
    if (exactSchema) return exactSchema;
  }
  return byName.length === 1 ? byName[0] : null;
}

function primaryKeyColumns(table) {
  const source = Array.isArray(table?.primaryKey)
    ? table.primaryKey
    : table?.primaryKey?.columns ?? table?.primaryKeys ?? table?.pkColumns ?? [];
  return source
    .map(column => typeof column === 'string' ? column : column?.columnName ?? column?.name)
    .filter(Boolean);
}

function hasTopLevelPhrase(tokens, first, second) {
  return tokens.some(
    (token, index) =>
      token.depth === 0 &&
      tokenUpper(token) === first &&
      tokenUpper(tokens[index + 1]) === second &&
      tokens[index + 1]?.depth === 0
  );
}

function addPrimaryKeyOrder(sql, options = {}) {
  if (Array.isArray(options)) {
    options = { primaryKeyColumns: options, range: true };
  }
  const { range, snapshot } = options;
  if (!range) return sql;

  const tokens = significantTokens(tokenizeSql(sql));
  if (hasTopLevelPhrase(tokens, 'ORDER', 'BY')) return sql;
  if (
    tokens.some(
      token =>
        token.depth === 0 &&
        ['DISTINCT', 'GROUP', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT'].includes(tokenUpper(token))
    )
  ) {
    return sql;
  }

  const limit = tokens.find(token => token.depth === 0 && tokenUpper(token) === 'LIMIT');
  if (!limit) return sql;

  const reference = parseBaseTable(tokens);
  if (!reference) return sql;
  let columns = options.primaryKeyColumns;
  if (!columns) {
    columns = primaryKeyColumns(findTable(snapshot, reference));
  }
  if (!Array.isArray(columns) || columns.length === 0) return sql;

  const order = columns
    .map(column => `${escapeIdentifier('basetbl')}.${escapeIdentifier(column)}`)
    .join(', ');
  const before = sql.slice(0, limit.start);
  const after = sql.slice(limit.start);
  const leading = before.length > 0 && !/\s$/.test(before) ? '\n' : '';
  return `${before}${leading}ORDER BY ${order}\n${after}`;
}

module.exports = {
  addPrimaryKeyOrder,
  escapeIdentifier,
};
