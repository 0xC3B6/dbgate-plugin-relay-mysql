'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_RESULT_BYTES, PROTOCOL_VERSION } = require('../runner/constants');
const { encodePacket, readPacket } = require('../broker/protocol');
const { RelayMysqlError } = require('./errors');

const BROKER_START_TIMEOUT_MS = 5_000;
const BROKER_START_LOCK_STALE_MS = 10_000;
const LOCAL_WATCHDOG_GRACE_MS = 1_500;
const SAFE_MESSAGES = Object.freeze({
  relay_login: 'Relay authentication failed',
  ssh: 'SSH connection failed',
  mysql_connection: 'MySQL connection failed',
  sql_error: 'MySQL rejected the query',
  timeout: 'Relay query timed out',
  result_too_large: 'Relay result exceeded the configured size limit',
  runner: 'Persistent Relay broker failed',
});

function defaultBrokerSocketPath() {
  const uid = process.getuid?.() ?? 'user';
  return path.join('/tmp', `dbgate-relay-mysql-${uid}`, 'broker-v1.sock');
}

function resolveDefaultBrokerPath() {
  const candidates = [
    path.resolve(__dirname, 'broker.js'),
    path.resolve(__dirname, '../../dist/broker.js'),
    path.resolve(process.cwd(), 'dist/broker.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function ensurePrivateRuntimeDirectory(socketPath) {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Broker runtime directory is not private');
  }
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = error => {
      socket.removeListener('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class BrokerClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || defaultBrokerSocketPath();
    this.brokerPath = options.brokerPath || resolveDefaultBrokerPath();
    this.spawn = options.spawn || spawn;
    this.autoStart = options.autoStart !== false;
    this.environment = options.environment || process.env;
  }

  async connect() {
    try {
      return await connect(this.socketPath);
    } catch (firstError) {
      if (!this.autoStart) throw firstError;
    }

    ensurePrivateRuntimeDirectory(this.socketPath);
    const lockPath = `${this.socketPath}.start.lock`;
    let lockDescriptor;
    try {
      lockDescriptor = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if ((!process.getuid || stat.uid === process.getuid()) && Date.now() - stat.mtimeMs > BROKER_START_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          lockDescriptor = fs.openSync(lockPath, 'wx', 0o600);
        }
      } catch (_lockError) {
        // Another client may have completed broker startup while this client
        // inspected the lock. The connection retry loop below is authoritative.
      }
    }

    if (lockDescriptor !== undefined) {
      try {
        try {
          const stat = fs.lstatSync(this.socketPath);
          if (stat.isSocket() && (!process.getuid || stat.uid === process.getuid())) fs.rmSync(this.socketPath, { force: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }

        const broker = this.spawn(process.execPath, [this.brokerPath, '--socket', this.socketPath], {
          detached: true,
          env: this.environment,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        broker.on('error', () => {});
        broker.unref?.();
      } catch (error) {
        fs.closeSync(lockDescriptor);
        lockDescriptor = undefined;
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
    }

    const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const socket = await connect(this.socketPath);
        if (lockDescriptor !== undefined) {
          fs.closeSync(lockDescriptor);
          lockDescriptor = undefined;
          fs.rmSync(lockPath, { force: true });
        }
        return socket;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    if (lockDescriptor !== undefined) {
      fs.closeSync(lockDescriptor);
      fs.rmSync(lockPath, { force: true });
    }
    throw lastError || new Error('Persistent Relay broker did not start');
  }

  async run(options) {
    const queryId = options.requestId;
    let socket;
    try {
      socket = await this.connect();
    } catch (_error) {
      throw new RelayMysqlError('runner', 'Persistent Relay broker could not be started', { queryId });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = Number(options.timeoutMs) + LOCAL_WATCHDOG_GRACE_MS;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onAbort = () => fail(new RelayMysqlError('runner', 'Relay query was cancelled locally', { queryId }));
      const timer = setTimeout(() => {
        fail(new RelayMysqlError('timeout', 'Relay query exceeded its local timeout', { queryId }));
      }, timeoutMs);
      timer.unref?.();

      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      const packet = encodePacket({
        version: PROTOCOL_VERSION,
        requestId: queryId,
        profile: String(options.relayProfile),
        profileFile: options.profileFile ? String(options.profileFile) : undefined,
        database: options.database ? String(options.database) : '',
        timeoutMs: Number(options.timeoutMs),
      }, Buffer.from(String(options.sql), 'utf8'));

      readPacket(socket, { maxBodyBytes: MAX_RESULT_BYTES }).then(response => {
        if (settled) return;
        if (response.header?.version !== PROTOCOL_VERSION || response.header?.requestId !== queryId) {
          fail(new RelayMysqlError('runner', 'Persistent Relay broker returned an invalid response', { queryId }));
          return;
        }
        if (!response.header.ok) {
          const category = Object.hasOwn(SAFE_MESSAGES, response.header.category) ? response.header.category : 'runner';
          fail(new RelayMysqlError(category, SAFE_MESSAGES[category], {
            queryId,
            details: { exitCode: response.header.exitCode },
          }));
          return;
        }
        settled = true;
        cleanup();
        socket.destroy();
        resolve({ queryId, stdout: response.body, stderr: Buffer.alloc(0), exitCode: 0, persistent: true });
      }).catch(() => {
        fail(new RelayMysqlError('runner', 'Persistent Relay broker connection failed', { queryId }));
      });

      socket.write(packet);
    });
  }
}

module.exports = {
  BROKER_START_TIMEOUT_MS,
  BROKER_START_LOCK_STALE_MS,
  BrokerClient,
  defaultBrokerSocketPath,
  ensurePrivateRuntimeDirectory,
  resolveDefaultBrokerPath,
};
