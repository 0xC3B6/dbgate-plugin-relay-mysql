'use strict';

const { mysqlSplitterOptions } = require('dbgate-query-splitter/lib/options');

const driverBase = global.DBGATE_PACKAGES?.['dbgate-tools']?.driverBase || {};

const STRIPPED_CONNECTION_FIELDS = [
  'server',
  'port',
  'user',
  'databaseFile',
  'databaseUrl',
  'connectionDefinition',
  'authType',
  'serviceName',
  'serviceNameType',
  'socketPath',
  'windowsDomain',
  'trustServerCertificate',
  'password',
  'passwordEncrypted',
  'passwordMode',
  'authToken',
  'apiKeyValue',
  'endpointKey',
  'accessKeyId',
  'secretAccessKey',
  'httpProxyPassword',
  'httpProxyUrl',
  'httpProxyUser',
  'sshHost',
  'sshPort',
  'sshMode',
  'sshLogin',
  'sshBastionHost',
  'sshPassword',
  'sshKeyFile',
  'sshKeyPassphrase',
  'sshKeyfilePassword',
  'sshKeyFilePassword',
  'sslCertFilePassword',
  'sslCaFile',
  'sslKeyFile',
  'sslRejectUnauthorized',
  'sslKeyFilePassword',
  'endpoint',
  'awsRegion',
  'defaultIsolationLevel',
];

const dialect = {
  ...(driverBase.dialect || {}),
  limitSelect: true,
  rangeSelect: true,
  offsetFetchRangeSyntax: false,
  stringEscapeChar: '\\',
  fallbackDataType: 'longtext',
  quoteIdentifier(value) {
    return `\`${String(value).replace(/`/g, '``')}\``;
  },
};

const driver = {
  ...driverBase,
  engine: 'relay-mysql@dbgate-plugin-relay-mysql',
  title: 'Relay MySQL',
  databaseEngineTypes: ['sql'],
  dialect,
  readOnlySessions: true,
  supportsEditableQueryResults: false,
  supportsTransactions: false,
  supportsIncrementalAnalysis: true,
  supportedCreateDatabase: false,
  supportExecuteQuery: true,
  dataEditorTypesBehaviour: {
    parseSqlNull: true,
  },
  showConnectionField(field) {
    return ['defaultDatabase', 'singleDatabase'].includes(field);
  },
  showConnectionTab() {
    return false;
  },
  getAdvancedConnectionFields() {
    return [
      {
        type: 'text',
        name: 'relayProfile',
        label: 'Relay profile',
        default: 'default',
        placeholder: 'Profile resolved by the local runner',
      },
      {
        type: 'text',
        name: 'runnerPath',
        label: 'Runner executable path',
        placeholder: 'Leave empty to use the bundled runner',
      },
      {
        type: 'number',
        name: 'timeoutMs',
        label: 'Query timeout (milliseconds)',
        default: 30000,
      },
    ];
  },
  getQuerySplitterOptions() {
    // DbGate 7.2.1's editor assumes rich splitter results include trimStart.
    // The query-splitter package omits that field in `noSplit` mode, which
    // crashes the editor before Execute can reach the backend. Disabling every
    // statement delimiter produces one rich result while the backend policy
    // remains the authority that rejects multi-statement SQL.
    return {
      ...mysqlSplitterOptions,
      allowSemicolon: false,
      allowCustomDelimiter: false,
      noSplit: false,
    };
  },
  getNewObjectTemplates() {
    return [];
  },
  beforeConnectionSave(connection) {
    const sanitized = {
      ...connection,
      isReadOnly: true,
      useDatabaseUrl: false,
      useSshTunnel: false,
      useSsl: false,
      useSeparateSchemas: false,
    };
    for (const field of STRIPPED_CONNECTION_FIELDS) delete sanitized[field];
    return sanitized;
  },
};

module.exports = driver;
Object.defineProperty(module.exports, 'STRIPPED_CONNECTION_FIELDS', {
  value: STRIPPED_CONNECTION_FIELDS,
  enumerable: false,
});
