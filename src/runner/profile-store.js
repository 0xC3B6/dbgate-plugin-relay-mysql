'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND = /^[A-Za-z0-9_./+-]+$/;
const SSH_TARGET = /^[A-Za-z0-9_.@%:+-]+$/;
const HOST = /^[A-Za-z0-9_.:%-]+$/;
const STORED_PROFILE_FIELDS = new Set([
  'relayCommand',
  'relayArgs',
  'relayPrompt',
  'relayPasswordPrompt',
  'relayPasswordEnv',
  'sshTarget',
  'sshPrompt',
  'sshPasswordPrompt',
  'sshPasswordEnv',
  'mysqlCommand',
  'mysqlHost',
  'mysqlPort',
  'mysqlUserEnv',
  'mysqlPasswordEnv',
]);
const INLINE_SECRET_FIELDS = new Set([
  'relayPassword',
  'sshPassword',
  'mysqlUser',
  'mysqlPassword',
]);

class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.code = 'PROFILE_INVALID';
  }
}

function defaultProfilePath(env = process.env) {
  return env.DBGATE_RELAY_MYSQL_PROFILE_FILE || path.join(os.homedir(), '.config', 'dbgate-relay-mysql', 'profiles.json');
}

function assertString(value, label, pattern, { optional = false, max = 1024 } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new ProfileError(`${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw new ProfileError(`${label} is invalid`);
  return value;
}

function resolveEnv(profile, key, env, { optional = false } = {}) {
  const envName = assertString(profile[`${key}Env`], `${key}Env`, ENV_NAME, { optional, max: 128 });
  if (!envName) return '';
  const value = env[envName];
  if (typeof value !== 'string' || (!optional && value.length === 0) || /[\0\r\n]/.test(value)) {
    throw new ProfileError(`${key} environment value is unavailable`);
  }
  return value;
}

function validateStoredProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProfileError('profile is invalid');
  }
  for (const field of Object.keys(profile)) {
    if (INLINE_SECRET_FIELDS.has(field)) throw new ProfileError('profile contains an inline secret');
    if (!STORED_PROFILE_FIELDS.has(field)) throw new ProfileError('profile contains an unknown field');
  }

  const relayArgs = profile.relayArgs ?? [];
  if (!Array.isArray(relayArgs) || relayArgs.length > 32) throw new ProfileError('relayArgs is invalid');
  const checkedArgs = relayArgs.map((arg) => {
    const value = assertString(arg, 'relay argument', null, { max: 2048 });
    if (/[\x00-\x1f\x7f]/.test(value)) throw new ProfileError('relay argument is invalid');
    return value;
  });

  const port = Number(profile.mysqlPort ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProfileError('mysqlPort is invalid');

  return Object.freeze({
    relayCommand: assertString(profile.relayCommand, 'relayCommand', COMMAND),
    relayArgs: Object.freeze(checkedArgs),
    relayPrompt: assertString(profile.relayPrompt, 'relayPrompt', null, { max: 512 }),
    relayPasswordPrompt: assertString(profile.relayPasswordPrompt ?? '(?i)password:', 'relayPasswordPrompt', null, { max: 512 }),
    relayPasswordEnv: assertString(profile.relayPasswordEnv, 'relayPasswordEnv', ENV_NAME, { optional: true, max: 128 }),
    sshTarget: assertString(profile.sshTarget, 'sshTarget', SSH_TARGET),
    sshPrompt: assertString(profile.sshPrompt, 'sshPrompt', null, { max: 512 }),
    sshPasswordPrompt: assertString(profile.sshPasswordPrompt ?? '(?i)password:', 'sshPasswordPrompt', null, { max: 512 }),
    sshPasswordEnv: assertString(profile.sshPasswordEnv, 'sshPasswordEnv', ENV_NAME, { optional: true, max: 128 }),
    mysqlCommand: assertString(profile.mysqlCommand ?? 'mysql', 'mysqlCommand', COMMAND),
    mysqlHost: assertString(profile.mysqlHost, 'mysqlHost', HOST),
    mysqlPort: port,
    mysqlUserEnv: assertString(profile.mysqlUserEnv, 'mysqlUserEnv', ENV_NAME, { max: 128 }),
    mysqlPasswordEnv: assertString(profile.mysqlPasswordEnv, 'mysqlPasswordEnv', ENV_NAME, { max: 128 }),
  });
}

function materializeProfile(profile, env = process.env) {
  const stored = validateStoredProfile(profile);
  return Object.freeze({
    ...stored,
    mysqlPort: String(stored.mysqlPort),
    relayPassword: resolveEnv(stored, 'relayPassword', env, { optional: true }),
    sshPassword: resolveEnv(stored, 'sshPassword', env, { optional: true }),
    mysqlUser: resolveEnv(stored, 'mysqlUser', env),
    mysqlPassword: resolveEnv(stored, 'mysqlPassword', env),
  });
}

function validateProfile(profile, env) {
  return materializeProfile(profile, env);
}

function loadProfile(profileName, options = {}) {
  assertString(profileName, 'profile name', PROFILE_NAME, { max: 64 });
  const filePath = path.resolve(options.filePath || defaultProfilePath(options.env));
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new ProfileError('profile file is unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ProfileError('profile file is not a regular file');
  if ((stat.mode & 0o077) !== 0) throw new ProfileError('profile file permissions must be 0600');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ProfileError('profile file owner is invalid');
  }

  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new ProfileError('profile file is not valid JSON');
  }
  if (
    document?.version !== 1 ||
    !document.profiles ||
    typeof document.profiles !== 'object' ||
    Array.isArray(document.profiles)
  ) {
    throw new ProfileError('profile file version is unsupported');
  }
  if (!Object.hasOwn(document.profiles, profileName)) throw new ProfileError('profile does not exist');
  return validateProfile(document.profiles[profileName], options.env || process.env);
}

module.exports = {
  ProfileError,
  defaultProfilePath,
  loadProfile,
  materializeProfile,
  validateProfile,
  validateStoredProfile,
};
