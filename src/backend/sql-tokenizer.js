'use strict';

const { RelayMysqlError } = require('./errors');

class SqlTokenizerError extends RelayMysqlError {
  constructor(rule) {
    super('sql_rejected', 'The SQL text is not a supported read-only statement.', {
      details: { rule },
    });
    this.name = 'SqlTokenizerError';
  }
}

function isWhitespace(char) {
  return char != null && /\s/u.test(char);
}

function isControlOrWhitespace(char) {
  return char == null || /[\s\x00-\x1f\x7f]/u.test(char);
}

function isWordStart(char) {
  return char != null && /[A-Za-z_$\p{L}]/u.test(char);
}

function isWordPart(char) {
  return char != null && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(char);
}

function decodeQuoted(raw, quote) {
  const body = raw.slice(1, -1);
  const doubled = new RegExp(`${quote}${quote}`, 'g');
  return body.replace(doubled, quote).replace(/\\([\s\S])/g, '$1');
}

function makeToken(type, sql, start, end, depth, value) {
  const raw = sql.slice(start, end);
  return {
    type,
    value: value == null ? raw : value,
    raw,
    start,
    end,
    depth,
  };
}

function readQuoted(sql, start, quote, type, depth) {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char === '\\') {
      if (index + 1 >= sql.length) throw new SqlTokenizerError('unterminated_quote');
      index += 2;
      continue;
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      const end = index + 1;
      return {
        next: end,
        token: makeToken(type, sql, start, end, depth, decodeQuoted(sql.slice(start, end), quote)),
      };
    }
    index += 1;
  }
  throw new SqlTokenizerError('unterminated_quote');
}

function readNumber(sql, start, depth) {
  let index = start;
  if (sql[index] === '0' && /[xX]/.test(sql[index + 1] || '')) {
    index += 2;
    while (/[0-9A-Fa-f]/.test(sql[index] || '')) index += 1;
  } else if (sql[index] === '0' && /[bB]/.test(sql[index + 1] || '')) {
    index += 2;
    while (/[01]/.test(sql[index] || '')) index += 1;
  } else {
    while (/\d/.test(sql[index] || '')) index += 1;
    if (sql[index] === '.') {
      index += 1;
      while (/\d/.test(sql[index] || '')) index += 1;
    }
    if (/[eE]/.test(sql[index] || '')) {
      const exponentStart = index;
      index += 1;
      if (/[+-]/.test(sql[index] || '')) index += 1;
      const digitsStart = index;
      while (/\d/.test(sql[index] || '')) index += 1;
      if (digitsStart === index) index = exponentStart;
    }
  }
  return {
    next: index,
    token: makeToken('number', sql, start, index, depth),
  };
}

function tokenizeSql(input) {
  if (typeof input !== 'string') throw new SqlTokenizerError('sql_must_be_string');

  const sql = input;
  const tokens = [];
  let index = 0;
  let depth = 0;

  while (index < sql.length) {
    const char = sql[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const result = readQuoted(sql, index, char, 'string', depth);
      tokens.push(result.token);
      index = result.next;
      continue;
    }

    if (char === '`') {
      const result = readQuoted(sql, index, char, 'quoted_identifier', depth);
      tokens.push(result.token);
      index = result.next;
      continue;
    }

    if (char === '#') {
      const start = index;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      tokens.push(makeToken('comment', sql, start, index, depth));
      continue;
    }

    if (char === '-' && sql[index + 1] === '-' && isControlOrWhitespace(sql[index + 2])) {
      const start = index;
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      tokens.push(makeToken('comment', sql, start, index, depth));
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const start = index;
      const executable = sql[index + 2] === '!' ||
        ((sql[index + 2] === 'M' || sql[index + 2] === 'm') && sql[index + 3] === '!');
      const close = sql.indexOf('*/', index + 2);
      if (close < 0) throw new SqlTokenizerError('unterminated_comment');
      index = close + 2;
      tokens.push(makeToken(executable ? 'executable_comment' : 'comment', sql, start, index, depth));
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(sql[index + 1] || ''))) {
      const result = readNumber(sql, index, depth);
      tokens.push(result.token);
      index = result.next;
      continue;
    }

    if (isWordStart(char)) {
      const start = index;
      index += 1;
      while (isWordPart(sql[index])) index += 1;
      tokens.push(makeToken('word', sql, start, index, depth));
      continue;
    }

    const three = sql.slice(index, index + 3);
    const two = sql.slice(index, index + 2);
    const operator = three === '->>'
      ? three
      : [':=', '<=', '>=', '<>', '!=', '||', '&&', '<<', '>>', '->'].includes(two)
        ? two
        : char;

    if (char === ')') {
      depth -= 1;
      if (depth < 0) throw new SqlTokenizerError('unbalanced_parentheses');
    }
    tokens.push(makeToken('symbol', sql, index, index + operator.length, depth));
    if (char === '(') depth += 1;
    index += operator.length;
  }

  if (depth !== 0) throw new SqlTokenizerError('unbalanced_parentheses');
  return tokens;
}

function significantTokens(tokens) {
  return tokens.filter(token => token.type !== 'comment');
}

function tokenUpper(token) {
  return token && token.type === 'word' ? token.value.toUpperCase() : '';
}

module.exports = {
  SqlTokenizerError,
  significantTokens,
  tokenUpper,
  tokenizeSql,
};
