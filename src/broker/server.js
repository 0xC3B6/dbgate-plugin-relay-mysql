'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EXIT_CODES, MAX_RESULT_BYTES, MAX_SQL_BYTES, PROTOCOL_VERSION, SAFE_ERRORS } = require('../runner/constants');
const { encodePacket, readPacket } = require('./protocol');
const { SessionManager } = require('./session-manager');

const PROFILE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateRequest(header, body) {
  if (header?.version !== PROTOCOL_VERSION) throw new Error('Unsupported broker protocol');
  if (!REQUEST_ID.test(header.requestId || '')) throw new Error('Invalid request ID');
  if (!PROFILE.test(header.profile || '')) throw new Error('Invalid profile');
  if (header.profileFile !== undefined && (typeof header.profileFile !== 'string' || header.profileFile.length > 4096)) {
    throw new Error('Invalid profile file');
  }
  if (header.database !== undefined && (typeof header.database !== 'string' || header.database.length > 256 || /[\0\r\n]/.test(header.database))) {
    throw new Error('Invalid database');
  }
  if (!Number.isInteger(header.timeoutMs) || header.timeoutMs < 100 || header.timeoutMs > 300000) {
    throw new Error('Invalid timeout');
  }
  if (body.length > MAX_SQL_BYTES) throw new Error('SQL exceeds the protocol limit');
  return {
    requestId: header.requestId,
    profile: header.profile,
    profileFile: header.profileFile,
    database: header.database || '',
    timeoutMs: header.timeoutMs,
    sql: body.toString('utf8'),
  };
}

function safeFailure(error, requestId) {
  const category = Object.hasOwn(SAFE_ERRORS, error?.category) ? error.category : 'runner';
  return {
    version: PROTOCOL_VERSION,
    ok: false,
    requestId: REQUEST_ID.test(requestId || '') ? requestId : 'unknown',
    category,
    exitCode: EXIT_CODES[category],
  };
}

function validateRuntimeDirectory(socketPath) {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Broker runtime directory is not private');
  }
}

function createBrokerServer(options = {}) {
  const socketPath = path.resolve(options.socketPath);
  const manager = options.manager || new SessionManager({ environment: options.environment });
  let activeConnections = 0;
  let lastActivityAt = Date.now();
  validateRuntimeDirectory(socketPath);

  const server = net.createServer(socket => {
    activeConnections += 1;
    lastActivityAt = Date.now();
    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    socket.once('close', onClose);

    void (async () => {
      let requestId = 'unknown';
      try {
        const packet = await readPacket(socket, { maxBodyBytes: MAX_SQL_BYTES });
        requestId = packet.header?.requestId || requestId;
        const request = validateRequest(packet.header, packet.body);
        request.signal = abortController.signal;
        const stdout = await manager.execute(request);
        if (socket.destroyed) return;
        socket.end(encodePacket({
          version: PROTOCOL_VERSION,
          ok: true,
          requestId: request.requestId,
          exitCode: 0,
        }, stdout));
      } catch (error) {
        if (!socket.destroyed) socket.end(encodePacket(safeFailure(error, requestId)));
      } finally {
        socket.removeListener('close', onClose);
      }
    })();

    socket.once('close', () => {
      activeConnections -= 1;
      lastActivityAt = Date.now();
    });
  });

  server.on('listening', () => fs.chmodSync(socketPath, 0o600));
  server.socketPath = socketPath;
  server.manager = manager;
  server.activeConnections = () => activeConnections;
  server.lastActivityAt = () => lastActivityAt;
  server.shutdown = callback => {
    manager.close();
    server.close(() => {
      fs.rmSync(socketPath, { force: true });
      callback?.();
    });
  };
  return server;
}

function parseSocketArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--socket' || !path.isAbsolute(argv[1])) throw new Error('Invalid broker arguments');
  return argv[1];
}

function main(argv = process.argv.slice(2)) {
  let server;
  try {
    const socketPath = parseSocketArgument(argv);
    server = createBrokerServer({ socketPath });
    server.once('error', () => process.exitCode = 1);
    server.listen(socketPath);
    const idleCheck = setInterval(() => {
      if (server.manager.size === 0 && server.activeConnections() === 0 && Date.now() - server.lastActivityAt() >= 60_000) {
        clearInterval(idleCheck);
        server.shutdown(() => process.exit(0));
      }
    }, 30_000);
    idleCheck.unref?.();
    const stop = () => server.shutdown(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (_error) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  createBrokerServer,
  main,
  parseSocketArgument,
  safeFailure,
  validateRequest,
  validateRuntimeDirectory,
};
