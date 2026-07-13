'use strict';

const { RelayMysqlError } = require('./errors');
const {
  significantTokens,
  tokenUpper,
  tokenizeSql,
} = require('./sql-tokenizer');
const { addPrimaryKeyOrder } = require('./pk-order');

const MAX_VISIBLE_ROWS = 5_000;
const PROBE_ROW_COUNT = MAX_VISIBLE_ROWS + 1;

const SQL_CONTEXT = Object.freeze({
  MANUAL: 'manual',
  TABLE_DATA: 'table_data',
  INTERNAL: 'internal',
});

const HIGH_RISK_FUNCTIONS = new Set([
  'BENCHMARK',
  'GET_LOCK',
  'LOAD_FILE',
  'RELEASE_LOCK',
  'SLEEP',
]);

function policyError(rule, message = 'The SQL text is not allowed by the read-only policy.') {
  return new RelayMysqlError('sql_rejected', message, { details: { rule } });
}

function isSymbol(token, symbol) {
  return token?.type === 'symbol' && token.raw === symbol;
}

function requireSingleStatement(tokens) {
  const semicolonIndexes = [];
  tokens.forEach((token, index) => {
    if (isSymbol(token, ';')) semicolonIndexes.push(index);
  });
  if (semicolonIndexes.length > 1) throw policyError('multiple_statements');
  if (semicolonIndexes.length === 1 && semicolonIndexes[0] !== tokens.length - 1) {
    throw policyError('multiple_statements');
  }
  return semicolonIndexes.length === 1;
}

function assertExplainSelect(tokens) {
  if (tokenUpper(tokens[1]) === 'SELECT') return;

  // MySQL accepts EXPLAIN FORMAT=JSON SELECT. Supporting the option does not
  // broaden the executable statement beyond SELECT.
  if (
    tokenUpper(tokens[1]) === 'FORMAT' &&
    isSymbol(tokens[2], '=') &&
    ['JSON', 'TREE'].includes(tokenUpper(tokens[3])) &&
    tokenUpper(tokens[4]) === 'SELECT'
  ) {
    return;
  }
  throw policyError('explain_non_select', 'EXPLAIN is allowed only for SELECT statements.');
}

function assertDenyRules(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const word = tokenUpper(token);
    const callableName = token.type === 'quoted_identifier'
      ? token.value.toUpperCase()
      : word;

    if (token.type === 'executable_comment') {
      throw policyError('executable_comment');
    }
    if (isSymbol(token, ':=')) throw policyError('assignment');
    if (word === 'INTO') throw policyError('select_into');
    if (word === 'DELIMITER' || word === 'CHARSET') {
      throw policyError('mysql_client_command');
    }
    if (HIGH_RISK_FUNCTIONS.has(callableName) && isSymbol(tokens[index + 1], '(')) {
      throw policyError('high_risk_function');
    }
    // The mysql client interprets bare backslash sequences itself before SQL
    // reaches the server. Reject every such client command, including \C
    // (charset) and \d (delimiter), while leaving backslashes inside quoted
    // SQL strings untouched because those are represented by a single token.
    if (isSymbol(token, '\\')) {
      throw policyError('mysql_client_command');
    }

    if (word === 'FOR' && ['UPDATE', 'SHARE'].includes(tokenUpper(tokens[index + 1]))) {
      throw policyError('locking_read');
    }
    if (
      word === 'LOCK' &&
      tokenUpper(tokens[index + 1]) === 'IN' &&
      tokenUpper(tokens[index + 2]) === 'SHARE' &&
      tokenUpper(tokens[index + 3]) === 'MODE'
    ) {
      throw policyError('locking_read');
    }
  }
}

function validateReadOnlySql(sql) {
  const allTokens = tokenizeSql(sql);
  if (allTokens.some(token => token.type === 'executable_comment')) {
    throw policyError('executable_comment');
  }

  const tokens = significantTokens(allTokens);
  if (tokens.length === 0) throw policyError('empty_statement');

  const terminalSemicolon = requireSingleStatement(tokens);
  const statementTokens = terminalSemicolon ? tokens.slice(0, -1) : tokens;
  if (statementTokens.length === 0) throw policyError('empty_statement');

  const statementType = tokenUpper(statementTokens[0]);
  if (!['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'].includes(statementType)) {
    throw policyError(
      'statement_type',
      'Only SELECT, SHOW, DESC, DESCRIBE, and EXPLAIN SELECT statements are allowed.'
    );
  }
  if (statementType === 'EXPLAIN') assertExplainSelect(statementTokens);
  assertDenyRules(statementTokens);

  return {
    sql,
    statementType,
    terminalSemicolon,
    tokens: allTokens,
  };
}

function topLevelTokens(validated) {
  return significantTokens(validated.tokens).filter(
    token => token.depth === 0 && !isSymbol(token, ';')
  );
}

function parseDecimalInteger(token, rule) {
  if (token?.type !== 'number' || !/^\d+$/.test(token.raw)) throw policyError(rule);
  try {
    return BigInt(token.raw);
  } catch {
    throw policyError(rule);
  }
}

function readTopLevelLimit(validated, { enforceMaximum }) {
  const tokens = topLevelTokens(validated);
  const indexes = [];
  tokens.forEach((token, index) => {
    if (tokenUpper(token) === 'LIMIT') indexes.push(index);
  });
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw policyError('invalid_limit');

  const tail = tokens.slice(indexes[0] + 1);
  let count;
  let offset = 0n;
  if (tail.length === 1) {
    count = parseDecimalInteger(tail[0], 'invalid_limit');
  } else if (tail.length === 3 && isSymbol(tail[1], ',')) {
    offset = parseDecimalInteger(tail[0], 'invalid_limit');
    count = parseDecimalInteger(tail[2], 'invalid_limit');
  } else if (tail.length === 3 && tokenUpper(tail[1]) === 'OFFSET') {
    count = parseDecimalInteger(tail[0], 'invalid_limit');
    offset = parseDecimalInteger(tail[2], 'invalid_limit');
  } else {
    throw policyError('invalid_limit');
  }

  if (enforceMaximum && count > BigInt(MAX_VISIBLE_ROWS)) {
    throw policyError(
      'limit_too_large',
      `Manual SELECT queries may request at most ${MAX_VISIBLE_ROWS} rows.`
    );
  }
  return {
    count: count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count,
    offset: offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : offset,
  };
}

function statementInsertionPoint(validated) {
  const significant = significantTokens(validated.tokens);
  if (validated.terminalSemicolon) {
    const semicolon = significant[significant.length - 1];
    return { end: semicolon.end, start: semicolon.start };
  }

  const last = significant[significant.length - 1];
  return { end: last.end, start: last.end };
}

function appendProbeLimit(validated) {
  const point = statementInsertionPoint(validated);
  const before = validated.sql.slice(0, point.start);
  const after = validated.sql.slice(point.end);
  return `${before} LIMIT ${PROBE_ROW_COUNT}${after}`;
}

function prepareManualSql(sql) {
  const validated = validateReadOnlySql(sql);
  if (validated.statementType !== 'SELECT') {
    return {
      sql,
      statementType: validated.statementType,
      maxVisibleRows: MAX_VISIBLE_ROWS,
      truncationProbe: false,
      explicitLimit: null,
    };
  }

  const explicitLimit = readTopLevelLimit(validated, { enforceMaximum: true });
  return {
    sql: explicitLimit ? sql : appendProbeLimit(validated),
    statementType: validated.statementType,
    maxVisibleRows: MAX_VISIBLE_ROWS,
    truncationProbe: !explicitLimit,
    explicitLimit,
  };
}

function prepareTableDataSql(sql, { range, snapshot } = {}) {
  const validated = validateReadOnlySql(sql);
  if (validated.statementType !== 'SELECT') {
    throw policyError('table_data_non_select');
  }

  return {
    sql: addPrimaryKeyOrder(sql, { range, snapshot }),
    statementType: validated.statementType,
    maxVisibleRows: null,
    truncationProbe: false,
    explicitLimit: readTopLevelLimit(validated, { enforceMaximum: false }),
  };
}

function prepareSql(sql, { context = SQL_CONTEXT.MANUAL, range, snapshot } = {}) {
  if (context === SQL_CONTEXT.TABLE_DATA) return prepareTableDataSql(sql, { range, snapshot });
  if (context === SQL_CONTEXT.INTERNAL) {
    const validated = validateReadOnlySql(sql);
    return {
      sql,
      statementType: validated.statementType,
      maxVisibleRows: null,
      truncationProbe: false,
      explicitLimit: null,
    };
  }
  return prepareManualSql(sql);
}

module.exports = {
  HIGH_RISK_FUNCTIONS,
  MAX_VISIBLE_ROWS,
  PROBE_ROW_COUNT,
  SQL_CONTEXT,
  prepareManualSql,
  prepareSql,
  prepareTableDataSql,
  validateReadOnlySql,
  validateSql: validateReadOnlySql,
};
