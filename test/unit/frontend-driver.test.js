'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { splitQuery } = require('dbgate-query-splitter');

function loadDriver() {
  global.DBGATE_PACKAGES = {
    'dbgate-tools': {
      driverBase: {
        databaseEngineTypes: ['sql'],
        dialect: {},
      },
    },
  };
  delete require.cache[require.resolve('../../src/frontend/driver')];
  return require('../../src/frontend/driver');
}

test('frontend driver exposes a read-only Relay MySQL connection form', () => {
  const driver = loadDriver();
  assert.equal(driver.engine, 'relay-mysql@dbgate-plugin-relay-mysql');
  assert.equal(driver.title, 'Relay MySQL');
  assert.equal(driver.readOnlySessions, true);
  assert.equal(driver.supportsEditableQueryResults, false);
  assert.equal(driver.supportedCreateDatabase, false);
  assert.equal(driver.showConnectionTab('ssh'), false);
  assert.equal(driver.getQuerySplitterOptions().noSplit, false);
  assert.equal(driver.getQuerySplitterOptions().allowSemicolon, false);
  assert.equal(driver.getQuerySplitterOptions().allowCustomDelimiter, false);
  const richCommands = splitQuery('SELECT 1; SELECT 2', {
    ...driver.getQuerySplitterOptions(),
    returnRichInfo: true,
  });
  assert.equal(richCommands.length, 1);
  assert.equal(richCommands[0].text, 'SELECT 1; SELECT 2');
  assert.deepEqual(richCommands[0].trimStart, { position: 0, line: 0, column: 0 });
  assert.deepEqual(
    driver.getAdvancedConnectionFields().map(field => field.name),
    ['relayProfile', 'runnerPath', 'timeoutMs']
  );
  assert.equal(driver.getAdvancedConnectionFields()[0].default, 'default');
});

test('connection save removes secret-shaped fields and forces readonly', () => {
  const driver = loadDriver();
  const source = {
    _id: 'fixture',
    engine: driver.engine,
    relayProfile: 'fixture-profile',
    runnerPath: '/synthetic/runner',
    timeoutMs: 1234,
    server: 'stale.example.invalid',
    user: 'stale-user',
    password: 'not-persisted',
    databaseUrl: 'mysql://user:not-persisted@example.invalid/db',
    connectionDefinition: 'not-persisted',
    authToken: 'not-persisted',
    secretAccessKey: 'not-persisted',
    httpProxyPassword: 'not-persisted',
    sshKeyfilePassword: 'not-persisted',
    sslKeyFilePassword: 'not-persisted',
  };
  const saved = driver.beforeConnectionSave(source);

  assert.equal(saved.isReadOnly, true);
  assert.equal(saved.relayProfile, 'fixture-profile');
  assert.equal(saved.password, undefined);
  assert.equal(saved.server, undefined);
  assert.equal(saved.user, undefined);
  assert.equal(saved.databaseUrl, undefined);
  assert.equal(saved.connectionDefinition, undefined);
  assert.equal(saved.authToken, undefined);
  assert.equal(saved.secretAccessKey, undefined);
  assert.equal(saved.httpProxyPassword, undefined);
  assert.equal(saved.sshKeyfilePassword, undefined);
  assert.equal(saved.sslKeyFilePassword, undefined);
  assert.equal(saved.useDatabaseUrl, false);
  assert.equal(saved.useSshTunnel, false);
  assert.equal(saved.useSsl, false);
  assert.equal(saved.useSeparateSchemas, false);
  assert.equal(source.password, 'not-persisted');
});

test('dialect quotes embedded backticks and frontend index exports the driver', () => {
  const driver = loadDriver();
  assert.equal(driver.dialect.quoteIdentifier('a`b'), '`a``b`');
  delete require.cache[require.resolve('../../src/frontend/index')];
  const plugin = require('../../src/frontend/index');
  assert.equal(plugin.packageName, 'dbgate-plugin-relay-mysql');
  assert.equal(plugin.drivers[0].engine, driver.engine);
});
