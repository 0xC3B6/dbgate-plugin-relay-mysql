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
  'relayPassword',
  'sshPassword',
  'mysqlUser',
  'mysqlPassword',
  'profileFile',
  'inlineProfileFile',
];

const inlineProfileDisabled = values => values?.useInlineProfile !== true;
const storedProfileDisabled = values => values?.useInlineProfile === true;

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
        type: 'dropdowntext',
        name: 'relayProfile',
        label: 'Connection preset / local profile',
        default: 'default',
        options: [
          { name: 'WAF sandbox', value: 'waf' },
          { name: 'ADAS sandbox', value: 'adas' },
          { name: 'Default profile', value: 'default' },
        ],
        disabledFn: storedProfileDisabled,
      },
      {
        type: 'checkbox',
        name: 'useInlineProfile',
        label: 'Use custom advanced Relay, SSH and MySQL settings',
        default: false,
      },
      {
        type: 'text',
        name: 'relayCommand',
        label: 'Relay · command',
        placeholder: '/path/to/relay-cli',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'stringlist',
        name: 'relayArgs',
        label: 'Relay · arguments (one per row)',
        addButtonLabel: 'Add relay argument',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'relayPrompt',
        label: 'Relay · ready prompt regular expression',
        placeholder: 'RELAY> \\$',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'relayPasswordPrompt',
        label: 'Relay · password prompt regular expression',
        default: '(?i)password:',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'relayPasswordEnv',
        label: 'Relay · password environment variable (optional)',
        placeholder: 'DBGATE_RELAY_PASSWORD',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'sshTarget',
        label: 'SSH · target executed inside Relay',
        placeholder: 'reader@sandbox.example.invalid',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'sshPrompt',
        label: 'SSH · ready prompt regular expression',
        placeholder: 'REMOTE> \\$',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'sshPasswordPrompt',
        label: 'SSH · password prompt regular expression',
        default: '(?i)password:',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'sshPasswordEnv',
        label: 'SSH · password environment variable (optional)',
        placeholder: 'DBGATE_SSH_PASSWORD',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'mysqlCommand',
        label: 'MySQL · remote command',
        default: 'mysql',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'mysqlHost',
        label: 'MySQL · host as seen from the SSH server',
        placeholder: '127.0.0.1',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'number',
        name: 'mysqlPort',
        label: 'MySQL · port',
        default: 3306,
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'mysqlUserEnv',
        label: 'MySQL · user environment variable',
        placeholder: 'DBGATE_MYSQL_USER',
        disabledFn: inlineProfileDisabled,
      },
      {
        type: 'text',
        name: 'mysqlPasswordEnv',
        label: 'MySQL · password environment variable',
        placeholder: 'DBGATE_MYSQL_PASSWORD',
        disabledFn: inlineProfileDisabled,
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
