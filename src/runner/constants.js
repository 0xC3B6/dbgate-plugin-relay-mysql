'use strict';

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_SQL_BYTES = 32 * 1024 * 1024;
const SQL_CHUNK_BYTES = 2 * 1024;
const MAX_SQL_CHUNK_COUNT = MAX_SQL_BYTES / SQL_CHUNK_BYTES;

const EXIT_CODES = Object.freeze({
  relay_login: 10,
  ssh: 11,
  mysql_connection: 12,
  sql_error: 13,
  timeout: 14,
  runner: 15,
  result_too_large: 15,
});

const SAFE_ERRORS = Object.freeze({
  relay_login: ['Relay session could not be established.', true],
  ssh: ['SSH session could not be established.', true],
  mysql_connection: ['MySQL connection could not be established.', true],
  sql_error: ['MySQL rejected the query.', false],
  timeout: ['The relay query exceeded its deadline.', true],
  result_too_large: ['The XML result exceeded the 32 MiB limit.', false],
  runner: ['The relay runner failed.', false],
});

module.exports = {
  DEFAULT_TIMEOUT_MS,
  EXIT_CODES,
  MAX_RESULT_BYTES,
  MAX_SQL_BYTES,
  MAX_SQL_CHUNK_COUNT,
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SAFE_ERRORS,
  SQL_CHUNK_BYTES,
};
