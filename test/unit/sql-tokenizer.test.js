'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SqlTokenizerError,
  significantTokens,
  tokenizeSql,
} = require('../../src/backend/sql-tokenizer');

test('tokenizer keeps semicolons and comment markers inside quoted values inert', () => {
  const tokens = tokenizeSql("SELECT '; -- not comment', `odd``name` FROM `t` # real comment\n;");
  const significant = significantTokens(tokens);

  assert.equal(significant.filter(token => token.raw === ';').length, 1);
  assert.equal(significant.find(token => token.type === 'string').value, '; -- not comment');
  assert.equal(significant.find(token => token.type === 'quoted_identifier').value, 'odd`name');
  assert.equal(tokens.filter(token => token.type === 'comment').length, 1);
});

test('MySQL double-dash comments require following whitespace', () => {
  const arithmetic = tokenizeSql('SELECT 4--2');
  assert.equal(arithmetic.filter(token => token.type === 'comment').length, 0);

  const commented = tokenizeSql('SELECT 4-- comment\n');
  assert.equal(commented.filter(token => token.type === 'comment').length, 1);
});

test('tokenizer identifies MySQL and MariaDB executable comments', () => {
  assert.equal(tokenizeSql('SELECT 1 /*!50000 + 1 */')[2].type, 'executable_comment');
  assert.equal(tokenizeSql('SELECT 1 /*M!100100 + 1 */')[2].type, 'executable_comment');
  assert.equal(tokenizeSql('SELECT 1 /* ordinary */')[2].type, 'comment');
});

test('tokenizer tracks nesting depth outside strings and comments', () => {
  const tokens = significantTokens(tokenizeSql('SELECT (SELECT 1 LIMIT 1) AS nested_value LIMIT 2'));
  const limits = tokens.filter(token => token.value.toUpperCase() === 'LIMIT');

  assert.deepEqual(limits.map(token => token.depth), [1, 0]);
});

test('tokenizer rejects unterminated quoted text, comments and parentheses safely', () => {
  for (const sql of ["SELECT 'private", 'SELECT 1 /* private', 'SELECT (1']) {
    assert.throws(
      () => tokenizeSql(sql),
      error => error instanceof SqlTokenizerError && !error.message.includes('private')
    );
  }
});
