'use strict';

const { SaxesParser } = require('saxes');

const { RelayMysqlError } = require('./errors');

const DEFAULT_MAX_ROWS = 5_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function parseError(rule = 'malformed_xml') {
  return new RelayMysqlError('parse', 'Unable to parse the MySQL XML result.', {
    details: { rule },
  });
}

function resultTooLargeError() {
  return new RelayMysqlError('result_too_large', 'The MySQL XML result exceeded the allowed size.');
}

function normalizeLimit(value, defaultValue, name) {
  if (value === undefined) return defaultValue;
  if (value === null || value === Infinity) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) throw parseError(`invalid_${name}`);
  return value;
}

function isNilAttribute(attributes) {
  return Object.entries(attributes || {}).some(([name, value]) => {
    const localName = name.toLowerCase().split(':').pop();
    return localName === 'nil' && ['true', '1'].includes(String(value).toLowerCase());
  });
}

function makeUniqueColumnNames(rawNames) {
  const used = new Set();
  const nextSuffix = new Map();
  return rawNames.map(rawName => {
    const base = rawName || 'column';
    if (!used.has(base)) {
      used.add(base);
      nextSuffix.set(base, 2);
      return base;
    }

    let suffix = nextSuffix.get(base) || 2;
    let candidate = `${base}__${suffix}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}__${suffix}`;
    }
    used.add(candidate);
    nextSuffix.set(base, suffix + 1);
    return candidate;
  });
}

function asChunks(readable) {
  if (typeof readable === 'string' || Buffer.isBuffer(readable) || readable instanceof Uint8Array) {
    return [readable];
  }
  if (readable && (readable[Symbol.asyncIterator] || readable[Symbol.iterator])) return readable;
  throw parseError('invalid_input');
}

class XmlResultParser {
  constructor(options = {}) {
    this.maxRows = normalizeLimit(options.maxRows, DEFAULT_MAX_ROWS, 'max_rows');
    this.maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'max_bytes');
    this.collectRows = options.collectRows !== false;
    this.onColumns = typeof options.onColumns === 'function' ? options.onColumns : null;
    this.onRow = typeof options.onRow === 'function' ? options.onRow : null;
    this.signal = options.signal;

    this.columns = null;
    this.rawColumnNames = null;
    this.rows = [];
    this.rowCount = 0;
    this.truncated = false;
    this.byteCount = 0;

    this.currentRow = null;
    this.currentField = null;
    this.resultsetSeen = false;
    this.resultsetClosed = false;
    this.parserFailure = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });

    this.parser = new SaxesParser({ xmlns: false });
    this.parser.on('opentag', tag => this.handleOpenTag(tag));
    this.parser.on('text', value => this.handleText(value));
    this.parser.on('cdata', value => this.handleText(value));
    this.parser.on('closetag', tag => this.handleCloseTag(tag));
    this.parser.on('error', () => {
      this.parserFailure = true;
    });
  }

  fail(rule) {
    throw parseError(rule);
  }

  handleOpenTag(tag) {
    const name = tag.name.toLowerCase();
    if (name === 'resultset') {
      if (this.resultsetSeen || this.currentRow || this.resultsetClosed) this.fail('invalid_structure');
      this.resultsetSeen = true;
      return;
    }
    if (name === 'row') {
      if (!this.resultsetSeen || this.resultsetClosed || this.currentRow) this.fail('invalid_structure');
      this.currentRow = [];
      return;
    }
    if (name === 'field') {
      if (!this.currentRow || this.currentField) this.fail('invalid_structure');
      if (!Object.prototype.hasOwnProperty.call(tag.attributes, 'name')) this.fail('field_without_name');
      this.currentField = {
        name: String(tag.attributes.name),
        nil: isNilAttribute(tag.attributes),
        text: '',
      };
      return;
    }

    // MySQL's result XML has only resultset/row/field elements. Refusing
    // extensions prevents ambiguous mapping into DbGate row objects.
    this.fail('unsupported_element');
  }

  handleText(value) {
    if (this.currentField) this.currentField.text += value;
  }

  emitColumns(fields) {
    this.rawColumnNames = fields.map(field => field.name);
    const uniqueNames = makeUniqueColumnNames(this.rawColumnNames);
    this.columns = uniqueNames.map(columnName => ({ columnName, dataType: 'string' }));
    this.onColumns?.(this.columns);
  }

  emitRow(fields) {
    if (!this.columns) this.emitColumns(fields);
    if (
      fields.length !== this.rawColumnNames.length ||
      fields.some((field, index) => field.name !== this.rawColumnNames[index])
    ) {
      this.fail('inconsistent_fields');
    }

    if (this.rowCount >= this.maxRows) {
      this.truncated = true;
      return;
    }

    const row = {};
    fields.forEach((field, index) => {
      // Assignment to `__proto__` on a normal object invokes the legacy
      // prototype setter instead of creating a result column. Defining every
      // value as an own enumerable property preserves arbitrary MySQL column
      // names while keeping the ordinary object prototype DbGate expects.
      Object.defineProperty(row, this.columns[index].columnName, {
        configurable: true,
        enumerable: true,
        value: field.nil ? null : field.text,
        writable: true,
      });
    });
    const rowIndex = this.rowCount;
    this.rowCount += 1;
    if (this.collectRows) this.rows.push(row);
    this.onRow?.(row, rowIndex);
  }

  handleCloseTag(tag) {
    const name = tag.name.toLowerCase();
    if (name === 'field') {
      if (!this.currentRow || !this.currentField) this.fail('invalid_structure');
      this.currentRow.push(this.currentField);
      this.currentField = null;
      return;
    }
    if (name === 'row') {
      if (!this.currentRow || this.currentField) this.fail('invalid_structure');
      const fields = this.currentRow;
      this.currentRow = null;
      this.emitRow(fields);
      return;
    }
    if (name === 'resultset') {
      if (!this.resultsetSeen || this.currentRow || this.currentField) this.fail('invalid_structure');
      this.resultsetClosed = true;
    }
  }

  write(chunk) {
    if (this.signal?.aborted) {
      throw new RelayMysqlError('runner', 'MySQL XML parsing was cancelled.');
    }

    const byteLength = typeof chunk === 'string'
      ? Buffer.byteLength(chunk, 'utf8')
      : Buffer.byteLength(chunk);
    this.byteCount += byteLength;
    if (this.byteCount > this.maxBytes) throw resultTooLargeError();

    let decoded;
    try {
      decoded = this.decoder.decode(
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        { stream: true }
      );
      this.parser.write(decoded);
    } catch (error) {
      if (error instanceof RelayMysqlError) throw error;
      throw parseError('malformed_xml');
    }
    if (this.parserFailure) throw parseError('malformed_xml');
  }

  finish() {
    try {
      const tail = this.decoder.decode();
      if (tail) this.parser.write(tail);
      this.parser.close();
    } catch (error) {
      if (error instanceof RelayMysqlError) throw error;
      throw parseError('malformed_xml');
    }
    if (this.parserFailure) throw parseError('malformed_xml');
    if (!this.resultsetSeen || !this.resultsetClosed) throw parseError('missing_resultset');
    if (!this.columns) this.emitColumns([]);
    return {
      columns: this.columns,
      rows: this.rows,
      rowCount: this.rowCount,
      truncated: this.truncated,
    };
  }

  async parse(readable) {
    try {
      for await (const chunk of asChunks(readable)) this.write(chunk);
      return this.finish();
    } catch (error) {
      if (error instanceof RelayMysqlError) throw error;
      throw parseError('stream_failure');
    }
  }
}

async function parseMysqlXml(readable, options) {
  return new XmlResultParser(options).parse(readable);
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  XmlResultParser,
  makeUniqueColumnNames,
  parseMysqlXml,
  parseXmlResult: parseMysqlXml,
};
