'use strict';

const { RelayMysqlError } = require('./errors');
const { MetadataCache, createMetadataCacheKey } = require('./metadata-cache');

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const ENGINE = 'relay-mysql@dbgate-plugin-relay-mysql';

function createSqlUtf8Literal(value) {
  const hex = Buffer.from(String(value), 'utf8').toString('hex');
  return `CONVERT(0x${hex} USING utf8mb4)`;
}

function createMetadataSnapshotSql(database) {
  const schema = createSqlUtf8Literal(database);
  return `SELECT
  t.TABLE_NAME AS object_name,
  t.TABLE_TYPE AS object_kind,
  t.TABLE_COMMENT AS object_comment,
  c.COLUMN_NAME AS column_name,
  c.ORDINAL_POSITION AS ordinal_position,
  c.DATA_TYPE AS data_type,
  c.COLUMN_TYPE AS column_type,
  c.IS_NULLABLE AS is_nullable,
  c.EXTRA AS extra,
  c.COLUMN_COMMENT AS column_comment,
  pk.ORDINAL_POSITION AS primary_key_ordinal
FROM information_schema.TABLES t
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
 AND c.TABLE_NAME = t.TABLE_NAME
LEFT JOIN information_schema.KEY_COLUMN_USAGE pk
  ON pk.CONSTRAINT_SCHEMA = c.TABLE_SCHEMA
 AND pk.TABLE_NAME = c.TABLE_NAME
 AND pk.COLUMN_NAME = c.COLUMN_NAME
 AND pk.CONSTRAINT_NAME = 'PRIMARY'
WHERE t.TABLE_SCHEMA = ${schema}
  AND t.TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
  AND t.TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED', 'VIEW')
ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION`;
}

function parseOrdinal(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function mapMetadataRows(rows, database) {
  const objects = new Map();
  for (const row of rows || []) {
    if (!row?.object_name) continue;
    const objectName = String(row.object_name);
    let object = objects.get(objectName);
    if (!object) {
      object = {
        pureName: objectName,
        objectId: objectName,
        objectComment: row.object_comment || undefined,
        kind: String(row.object_kind || '').toUpperCase() === 'VIEW' ? 'view' : 'table',
        columns: [],
      };
      objects.set(objectName, object);
    }
    if (!row.column_name) continue;
    const ordinal = parseOrdinal(row.ordinal_position);
    object.columns.push({
      columnName: String(row.column_name),
      dataType: String(row.column_type || row.data_type || 'text'),
      notNull: String(row.is_nullable || '').toUpperCase() === 'NO',
      autoIncrement: String(row.extra || '').toLowerCase().includes('auto_increment'),
      columnComment: row.column_comment || undefined,
      ordinal: ordinal ?? Number.MAX_SAFE_INTEGER,
      primaryKeyOrdinal: parseOrdinal(row.primary_key_ordinal),
    });
  }

  const tables = [];
  const views = [];
  for (const object of objects.values()) {
    object.columns.sort((left, right) => left.ordinal - right.ordinal);
    const columns = object.columns.map(({ ordinal: _ordinal, primaryKeyOrdinal: _pkOrdinal, ...column }) => column);
    if (object.kind === 'view') {
      views.push({
        engine: ENGINE,
        pureName: object.pureName,
        objectId: object.objectId,
        objectComment: object.objectComment,
        columns,
      });
      continue;
    }

    const primaryColumns = object.columns
      .filter(column => column.primaryKeyOrdinal != null)
      .sort((left, right) => left.primaryKeyOrdinal - right.primaryKeyOrdinal)
      .map(column => ({ columnName: column.columnName }));
    tables.push({
      engine: ENGINE,
      pureName: object.pureName,
      objectId: object.objectId,
      objectComment: object.objectComment,
      columns,
      foreignKeys: [],
      ...(primaryColumns.length
        ? {
            primaryKey: {
              pureName: 'PRIMARY',
              constraintName: 'PRIMARY',
              constraintType: 'primaryKey',
              columns: primaryColumns,
            },
          }
        : {}),
    });
  }

  return {
    engine: ENGINE,
    database,
    tables,
    views,
    matviews: [],
    procedures: [],
    functions: [],
    triggers: [],
    schedulerEvents: [],
    collections: [],
  };
}

class MetadataSnapshotService {
  constructor(options = {}) {
    this.queryExecutor = options.queryExecutor;
    this.cache = options.cache || new MetadataCache();
  }

  cacheKey(dbhan) {
    return createMetadataCacheKey({
      connectionId: dbhan.conid,
      relayProfile: dbhan.relayProfile,
      runnerPath: dbhan.runnerPath,
      database: dbhan.database,
    });
  }

  async load(dbhan, options = {}) {
    const database = String(dbhan?.database || '').trim();
    if (!database || SYSTEM_DATABASES.has(database.toLowerCase())) {
      if (database && SYSTEM_DATABASES.has(database.toLowerCase())) return mapMetadataRows([], database);
      throw new RelayMysqlError('mysql_connection', 'Select a database before loading its objects');
    }
    const key = this.cacheKey(dbhan);
    return this.cache.getOrLoad(
      key,
      async () => {
        const result = await this.queryExecutor.executeInternal(dbhan, createMetadataSnapshotSql(database), {
          maxRows: null,
          collectRows: true,
        });
        return mapMetadataRows(result.rows, database);
      },
      { force: Boolean(options.force) }
    );
  }

  invalidate(dbhan) {
    this.cache.invalidate(this.cacheKey(dbhan));
  }

  isFresh(dbhan) {
    return this.cache.isFresh(this.cacheKey(dbhan));
  }
}

module.exports = {
  MetadataSnapshotService,
  SYSTEM_DATABASES,
  createSqlUtf8Literal,
  createMetadataSnapshotSql,
  mapMetadataRows,
};
