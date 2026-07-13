'use strict';

const { Readable } = require('node:stream');
const { RelayMysqlError } = require('./errors');
const { prepareManualSql, prepareTableDataSql } = require('./sql-policy');
const { parseMysqlXml } = require('./xml-result-parser');

function preparedMaxRows(prepared) {
  if (Object.prototype.hasOwnProperty.call(prepared, 'maxVisibleRows')) return prepared.maxVisibleRows;
  if (Object.prototype.hasOwnProperty.call(prepared, 'visibleRowLimit')) return prepared.visibleRowLimit;
  return 5000;
}

class QueryExecutor {
  constructor(options = {}) {
    this.runnerClient = options.runnerClient;
    this.prepareManualSql = options.prepareManualSql || prepareManualSql;
    this.prepareTableDataSql = options.prepareTableDataSql || prepareTableDataSql;
    this.parseMysqlXml = options.parseMysqlXml || parseMysqlXml;
  }

  async executePrepared(dbhan, prepared, options = {}) {
    if (!this.runnerClient) throw new Error('QueryExecutor requires a runnerClient');
    if (dbhan?.closed) {
      throw new RelayMysqlError('runner', 'Relay connection is already closed');
    }

    const runnerResult = await this.runnerClient.run({
      runnerPath: dbhan.runnerPath,
      relayProfile: dbhan.relayProfile,
      database: dbhan.database,
      timeoutMs: dbhan.timeoutMs,
      sql: prepared.sql,
      signal: options.signal,
    });

    try {
      const parsed = await this.parseMysqlXml(Readable.from([runnerResult.stdout]), {
        maxRows: preparedMaxRows(prepared),
        onColumns: options.onColumns,
        onRow: options.onRow,
        collectRows: options.collectRows !== false,
        signal: options.signal,
      });
      return {
        ...parsed,
        queryId: runnerResult.queryId,
        statementType: prepared.statementType,
        truncationProbe: Boolean(prepared.truncationProbe),
      };
    } catch (error) {
      if (error instanceof RelayMysqlError && error.queryId) throw error;
      const category = error instanceof RelayMysqlError ? error.category : 'parse';
      const message = error instanceof RelayMysqlError ? error.message : 'MySQL XML result could not be parsed';
      throw new RelayMysqlError(category, message, { queryId: runnerResult.queryId });
    }
  }

  executeManual(dbhan, sql, options = {}) {
    return this.executePrepared(dbhan, this.prepareManualSql(sql), options);
  }

  executeTableData(dbhan, sql, options = {}) {
    const prepared = this.prepareTableDataSql(sql, {
      range: options.range,
      snapshot: options.snapshot,
    });
    return this.executePrepared(dbhan, prepared, options);
  }

  executeInternal(dbhan, sql, options = {}) {
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new RelayMysqlError('runner', 'Internal query is empty');
    }
    return this.executePrepared(
      dbhan,
      {
        sql,
        statementType: 'internal',
        maxVisibleRows: options.maxRows ?? null,
        truncationProbe: false,
        explicitLimit: false,
      },
      options
    );
  }
}

module.exports = {
  QueryExecutor,
  preparedMaxRows,
};
