'use strict';

const { MAX_SQL_CHUNK_COUNT, PROTOCOL_VERSION } = require('./constants');
const { encodeFrame, encodeSqlChunks } = require('./frame-codec');

const SESSION_STARTUP_FIELDS = Object.freeze([
  'protocolVersion',
  'relayCommand',
  'relayArgs',
  'relayPrompt',
  'relayPasswordPrompt',
  'relayPassword',
  'sshTarget',
  'sshPrompt',
  'sshPasswordPrompt',
  'sshPassword',
  'mysqlCommand',
  'mysqlHost',
  'mysqlPort',
  'mysqlUser',
  'mysqlPassword',
  'remoteScript',
]);

function encodeSessionStartup(profile, remoteScript) {
  const values = {
    protocolVersion: PROTOCOL_VERSION,
    relayCommand: profile.relayCommand,
    relayArgs: profile.relayArgs.join('\n'),
    relayPrompt: profile.relayPrompt,
    relayPasswordPrompt: profile.relayPasswordPrompt,
    relayPassword: profile.relayPassword,
    sshTarget: profile.sshTarget,
    sshPrompt: profile.sshPrompt,
    sshPasswordPrompt: profile.sshPasswordPrompt,
    sshPassword: profile.sshPassword,
    mysqlCommand: profile.mysqlCommand,
    mysqlHost: profile.mysqlHost,
    mysqlPort: profile.mysqlPort,
    mysqlUser: profile.mysqlUser,
    mysqlPassword: profile.mysqlPassword,
    remoteScript,
  };
  return `${SESSION_STARTUP_FIELDS.map(field => encodeFrame(values[field])).join('\n')}\n`;
}

function encodeSessionRequest({ nonce, database, sql }) {
  const sqlChunks = encodeSqlChunks(sql);
  if (sqlChunks.length > MAX_SQL_CHUNK_COUNT) throw new RangeError('SQL frame count exceeds the protocol limit');
  return `${[
    encodeFrame(nonce),
    encodeFrame(database || ''),
    encodeFrame(sqlChunks.length),
    ...sqlChunks,
  ].join('\n')}\n`;
}

module.exports = {
  SESSION_STARTUP_FIELDS,
  encodeSessionRequest,
  encodeSessionStartup,
};
