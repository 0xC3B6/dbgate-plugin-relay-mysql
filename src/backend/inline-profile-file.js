'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateStoredProfile } = require('../runner/profile-store');

const INLINE_PROFILE_NAME = 'inline';
const INLINE_PROFILE_PREFIX = 'dbgate-relay-mysql-';

function connectionToStoredProfile(connection = {}) {
  return validateStoredProfile({
    relayCommand: connection.relayCommand,
    relayArgs: connection.relayArgs,
    relayPrompt: connection.relayPrompt,
    relayPasswordPrompt: connection.relayPasswordPrompt,
    relayPasswordEnv: connection.relayPasswordEnv,
    sshTarget: connection.sshTarget,
    sshPrompt: connection.sshPrompt,
    sshPasswordPrompt: connection.sshPasswordPrompt,
    sshPasswordEnv: connection.sshPasswordEnv,
    mysqlCommand: connection.mysqlCommand,
    mysqlHost: connection.mysqlHost,
    mysqlPort: connection.mysqlPort,
    mysqlUserEnv: connection.mysqlUserEnv,
    mysqlPasswordEnv: connection.mysqlPasswordEnv,
    ...Object.fromEntries(
      ['relayPassword', 'sshPassword', 'mysqlUser', 'mysqlPassword']
        .filter(field => Object.hasOwn(connection, field))
        .map(field => [field, connection[field]])
    ),
  });
}

function createInlineProfileFile(connection, options = {}) {
  const profile = connectionToStoredProfile(connection);
  const directory = fs.mkdtempSync(path.join(options.tmpDirectory || os.tmpdir(), INLINE_PROFILE_PREFIX));
  const filePath = path.join(directory, 'profiles.json');
  let cleaned = false;
  let descriptor;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(directory, { recursive: true, force: true });
  };

  try {
    fs.chmodSync(directory, 0o700);
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ version: 1, profiles: { [INLINE_PROFILE_NAME]: profile } }, null, 2)}\n`,
      'utf8'
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (_closeError) {
        // Best-effort cleanup after a failed private profile write.
      }
    }
    cleanup();
    throw error;
  }

  return Object.freeze({
    cleanup,
    filePath,
    profileName: INLINE_PROFILE_NAME,
  });
}

module.exports = {
  INLINE_PROFILE_NAME,
  connectionToStoredProfile,
  createInlineProfileFile,
};
