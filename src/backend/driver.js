'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const frontendDriver = require('../frontend/driver');
const { ProfileError } = require('../runner/profile-store');
const { RelayMysqlError } = require('./errors');
const { createInlineProfileFile: createInlineProfileFileDefault } = require('./inline-profile-file');
const { MetadataCache } = require('./metadata-cache');
const { MetadataSnapshotService, SYSTEM_DATABASES } = require('./metadata-snapshot');
const { QueryExecutor } = require('./query-executor');
const { RunnerClient, DEFAULT_TIMEOUT_MS } = require('./runner-client');

const backendDriverBase = global.DBGATE_PACKAGES?.['dbgate-tools']?.driverBase;
if (!backendDriverBase) {
  throw new Error('DbGate backend runtime did not provide dbgate-tools.driverBase');
}

function resolveDefaultRunnerPath() {
  const candidates = [
    path.resolve(__dirname, '../bin/relay-mysql-runner.js'),
    path.resolve(__dirname, '../../bin/relay-mysql-runner.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function normalizeTimeout(value) {
  const timeout = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) {
    throw new RelayMysqlError('runner', 'Timeout must be between 100 and 300000 milliseconds');
  }
  return timeout;
}

function firstRowValue(row, preferredNames) {
  for (const name of preferredNames) {
    if (row?.[name] != null) return row[name];
  }
  return row && typeof row === 'object' ? Object.values(row)[0] : undefined;
}

function createBackendDriver(dependencies = {}) {
  const runnerClient = dependencies.runnerClient || new RunnerClient();
  const queryExecutor = dependencies.queryExecutor || new QueryExecutor({ runnerClient });
  const metadataCache = dependencies.metadataCache || new MetadataCache();
  const metadataService =
    dependencies.metadataService || new MetadataSnapshotService({ queryExecutor, cache: metadataCache });
  const createInlineProfileFile = dependencies.createInlineProfileFile || createInlineProfileFileDefault;

  return {
    ...backendDriverBase,
    ...frontendDriver,
    dialect: {
      ...backendDriverBase.dialect,
      ...frontendDriver.dialect,
    },

    async connect(props = {}) {
      const configuredRunnerPath = String(props.runnerPath || '').trim();
      const runnerPath = configuredRunnerPath || resolveDefaultRunnerPath();
      const persistentSession = !configuredRunnerPath;
      const timeoutMs = normalizeTimeout(props.timeoutMs);
      let relayProfile;
      let profileFile;
      let cleanupProfile;

      if (props.useInlineProfile === true) {
        let inlineProfile;
        try {
          inlineProfile = createInlineProfileFile(props);
        } catch (error) {
          const message = error instanceof ProfileError
            ? error.message
            : 'UI-managed Relay profile could not be prepared';
          throw new RelayMysqlError('runner', message);
        }
        relayProfile = inlineProfile.profileName;
        profileFile = inlineProfile.filePath;
        cleanupProfile = inlineProfile.cleanup;
      } else {
        relayProfile = String(props.relayProfile || '').trim();
        if (!relayProfile) {
          throw new RelayMysqlError('relay_login', 'Relay profile is required');
        }
      }

      const client = { persistentSession, relayProfile, runnerPath, timeoutMs };
      return {
        client,
        cleanupProfile,
        conid: props.conid,
        database: props.database || props.defaultDatabase || null,
        profileFile,
        persistentSession,
        relayProfile,
        runnerPath,
        timeoutMs,
        closed: false,
      };
    },

    async close(dbhan) {
      if (!dbhan) return;
      dbhan.closed = true;
      const cleanupProfile = dbhan.cleanupProfile;
      dbhan.cleanupProfile = null;
      try {
        cleanupProfile?.();
      } catch (_error) {
        // Best-effort cleanup must not prevent DbGate from closing the
        // logical connection.
      }
    },

    async query(dbhan, sql, options = {}) {
      const result = options.range
        ? await queryExecutor.executeTableData(dbhan, sql, {
            range: options.range,
            snapshot: dbhan.metadataSnapshot,
            collectRows: true,
          })
        : await queryExecutor.executeManual(dbhan, sql, { collectRows: true });
      return {
        columns: result.columns || [],
        rows: result.rows || [],
      };
    },

    async stream(dbhan, sql, options = {}) {
      let recordsetStarted = false;
      try {
        const result = await queryExecutor.executeManual(dbhan, sql, {
          collectRows: false,
          onColumns(columns) {
            recordsetStarted = true;
            options.recordset?.(columns, { engine: frontendDriver.engine });
          },
          onRow(row) {
            options.row?.(row);
          },
        });
        if (!recordsetStarted) options.recordset?.(result.columns || [], { engine: frontendDriver.engine });
        if (result.truncated) {
          options.info?.({
            severity: 'info',
            time: new Date(),
            line: 0,
            message: 'Result truncated at 5,000 rows. Add a narrower WHERE clause or LIMIT.',
          });
        }
      } catch (error) {
        options.info?.({
          severity: 'error',
          time: new Date(),
          line: 0,
          message: error instanceof RelayMysqlError ? error.message : 'Relay query failed',
        });
      } finally {
        options.done?.();
      }
    },

    async readQuery(dbhan, sql, structure) {
      const pass = new PassThrough({ objectMode: true, highWaterMark: 100 });
      const abortController = new AbortController();
      pass.once('close', () => abortController.abort());

      void (async () => {
        let headerWritten = false;
        try {
          const result = await queryExecutor.executeTableData(dbhan, sql, {
            snapshot: structure,
            collectRows: false,
            signal: abortController.signal,
            onColumns(columns) {
              headerWritten = true;
              pass.write({
                __isStreamHeader: true,
                engine: frontendDriver.engine,
                ...(structure || { columns }),
              });
            },
            onRow(row) {
              pass.write(row);
            },
          });
          if (!headerWritten) {
            pass.write({
              __isStreamHeader: true,
              engine: frontendDriver.engine,
              ...(structure || { columns: result.columns || [] }),
            });
          }
          pass.end();
        } catch (error) {
          pass.destroy(error);
        }
      })();
      return pass;
    },

    async getVersion() {
      // DbGate polls this method in the background. A real version query would
      // create a Relay login (and therefore a Touch ID prompt) even when the
      // user is not querying data.
      return {
        version: 'relay-session',
        versionText: 'MySQL through persistent Relay session',
      };
    },

    async listDatabases(dbhan) {
      if (dbhan.database) return [{ name: String(dbhan.database) }];
      const result = await queryExecutor.executeInternal(dbhan, 'SHOW DATABASES', {
        maxRows: null,
        collectRows: true,
      });
      return (result.rows || [])
        .map(row => firstRowValue(row, ['Database', 'database']))
        .filter(value => value != null)
        .map(String)
        .filter(name => !SYSTEM_DATABASES.has(name.toLowerCase()))
        .map(name => ({ name }));
    },

    async analyseFull(dbhan) {
      const snapshot = await metadataService.load(dbhan, { force: true });
      dbhan.metadataSnapshot = snapshot;
      return snapshot;
    },

    async analyseIncremental(dbhan, structure) {
      if (!dbhan.metadataSnapshot && structure) dbhan.metadataSnapshot = structure;
      if (metadataService.isFresh?.(dbhan)) return null;
      const snapshot = await metadataService.load(dbhan, { force: false });
      dbhan.metadataSnapshot = snapshot;
      return snapshot;
    },

    async analyseSingleObject(dbhan, name, objectTypeField = 'tables') {
      const snapshot = await metadataService.load(dbhan, { force: false });
      const object = snapshot?.[objectTypeField]?.find(item => item.pureName === name.pureName);
      if (!object) throw new RelayMysqlError('mysql_connection', 'Requested database object was not found');
      return object;
    },

    analyseSingleTable(dbhan, name) {
      return this.analyseSingleObject(dbhan, name, 'tables');
    },

    __relayInternals: {
      metadataCache,
      metadataService,
      queryExecutor,
      runnerClient,
    },
  };
}

const driver = createBackendDriver();

module.exports = driver;
Object.defineProperties(module.exports, {
  createBackendDriver: { value: createBackendDriver, enumerable: false },
  normalizeTimeout: { value: normalizeTimeout, enumerable: false },
  resolveDefaultRunnerPath: { value: resolveDefaultRunnerPath, enumerable: false },
});
