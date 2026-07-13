'use strict';

const CATEGORY_CODE = /^[a-z][a-z0-9_]*$/;
const DISPLAYABLE_QUERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeCategory(category) {
  const value = String(category || 'runner').toLowerCase();
  return CATEGORY_CODE.test(value) ? value : 'runner';
}

class RelayMysqlError extends Error {
  constructor(category, message, options = {}) {
    // Also accept the conventional Error(message, options) shape. This keeps
    // callers from accidentally exposing an underlying Error message while the
    // category-first form remains the canonical API for this plugin.
    if (typeof message !== 'string') {
      options = message || {};
      message = category;
      category = options.category || 'runner';
    }

    const baseMessage = String(message || 'Relay MySQL request failed.');
    const queryId = options.queryId == null ? null : String(options.queryId);
    const displayQueryId = queryId && DISPLAYABLE_QUERY_ID.test(queryId) ? queryId : null;

    // DbGate 7.2.x only renders Error.message. Keep the correlation ID in the
    // message as well as on the error object, while refusing control
    // characters and other unsafe caller-provided values.
    super(displayQueryId ? `${baseMessage} (query ID: ${displayQueryId})` : baseMessage);
    this.name = 'RelayMysqlError';
    this.category = normalizeCategory(category);
    this.code = `RELAY_MYSQL_${this.category.toUpperCase()}`;

    if (queryId != null) this.queryId = queryId;
    if (options.details && typeof options.details === 'object') {
      this.details = { ...options.details };
    }

    // `cause` is deliberately non-enumerable. It is intended for local control
    // flow only and must never be serialized into user-facing responses/logs.
    if (options.cause instanceof RelayMysqlError) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }

    Error.captureStackTrace?.(this, RelayMysqlError);
  }
}

function createSafeError(category, message, options) {
  return new RelayMysqlError(category, message, options);
}

function asSafeError(error, category = 'runner', message = 'Relay MySQL request failed.') {
  if (error instanceof RelayMysqlError) return error;
  return new RelayMysqlError(category, message);
}

module.exports = {
  RelayMysqlError,
  asSafeError,
  createSafeError,
};
