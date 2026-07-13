'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { RelayMysqlError } = require('./errors');

const DEFAULT_STDOUT_LIMIT = 32 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const LOCAL_WATCHDOG_GRACE_MS = 1500;
const TERMINATION_GRACE_MS = 400;
const RUNNER_ERROR_CATEGORIES = new Set([
  'relay_login',
  'ssh',
  'mysql_connection',
  'sql_error',
  'timeout',
  'result_too_large',
  'runner',
]);
const SAFE_RUNNER_MESSAGES = Object.freeze({
  relay_login: 'Relay authentication failed',
  ssh: 'SSH connection failed',
  mysql_connection: 'MySQL connection failed',
  sql_error: 'MySQL rejected the query',
  timeout: 'Relay query timed out',
  result_too_large: 'Relay result exceeded the configured size limit',
  runner: 'Relay runner failed',
});

function appendLimited(chunks, chunk, state, limit) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextSize = state.size + buffer.length;
  if (nextSize > limit) return false;
  chunks.push(buffer);
  state.size = nextSize;
  return true;
}

function parseRunnerError(stderr, queryId, exitCode) {
  try {
    const payload = JSON.parse(stderr.toString('utf8').trim());
    if (
      payload.version !== 1 ||
      !RUNNER_ERROR_CATEGORIES.has(payload.category) ||
      payload.requestId !== queryId
    ) {
      throw new Error('Unsupported runner error payload');
    }
    return new RelayMysqlError(payload.category, SAFE_RUNNER_MESSAGES[payload.category], {
      queryId,
      details: {
        retryable: Boolean(payload.retryable),
        exitCode,
      },
    });
  } catch (error) {
    if (error instanceof RelayMysqlError) return error;
    return new RelayMysqlError('runner', 'Relay runner returned an invalid error response', {
      queryId,
      details: { exitCode },
    });
  }
}

class RunnerClient {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.randomUUID = options.randomUUID || randomUUID;
    this.prefixArgs = Array.isArray(options.prefixArgs) ? [...options.prefixArgs] : [];
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT;
  }

  run(options) {
    const queryId = options.requestId || this.randomUUID();
    const requestedTimeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : DEFAULT_TIMEOUT_MS;
    const args = [
      ...this.prefixArgs,
      '--protocol-version',
      '1',
      '--request-id',
      queryId,
      '--profile',
      String(options.relayProfile),
    ];
    if (options.profileFile) args.push('--profile-file', String(options.profileFile));
    if (options.database) args.push('--database', String(options.database));
    args.push('--timeout-ms', String(timeoutMs));

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let watchdog;
      let forceKillTimer;
      const stdout = [];
      const stderr = [];
      const stdoutState = { size: 0 };
      const stderrState = { size: 0 };

      const cleanup = () => {
        clearTimeout(watchdog);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const succeed = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const terminateChild = () => {
        try {
          child?.kill('SIGTERM');
        } catch (_error) {
          // The process may already have exited.
        }
        clearTimeout(forceKillTimer);
        forceKillTimer = setTimeout(() => {
          try {
            if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGKILL');
          } catch (_error) {
            // The process may have exited between the status check and kill.
          }
        }, TERMINATION_GRACE_MS);
        forceKillTimer.unref?.();
      };
      const onAbort = () => {
        terminateChild();
        fail(new RelayMysqlError('runner', 'Relay query was cancelled locally', { queryId }));
      };

      try {
        child = this.spawn(options.runnerPath, args, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (_error) {
        fail(new RelayMysqlError('runner', 'Relay runner could not be started', { queryId }));
        return;
      }

      child.stdout.on('data', chunk => {
        if (settled) return;
        if (!appendLimited(stdout, chunk, stdoutState, this.maxStdoutBytes)) {
          terminateChild();
          fail(
            new RelayMysqlError('result_too_large', 'Relay result exceeded the 32 MiB limit', {
              queryId,
              details: { maxBytes: this.maxStdoutBytes },
            })
          );
        }
      });
      child.stderr.on('data', chunk => {
        if (settled) return;
        if (!appendLimited(stderr, chunk, stderrState, this.maxStderrBytes)) {
          terminateChild();
          fail(
            new RelayMysqlError('runner', 'Relay runner error output exceeded the protocol limit', {
              queryId,
              details: { maxBytes: this.maxStderrBytes },
            })
          );
        }
      });
      child.on('error', () => {
        fail(new RelayMysqlError('runner', 'Relay runner could not be started', { queryId }));
      });
      child.on('close', exitCode => {
        clearTimeout(forceKillTimer);
        if (settled) return;
        if (exitCode === 0) {
          if (stderrState.size !== 0) {
            fail(
              new RelayMysqlError('runner', 'Relay runner returned an invalid success response', {
                queryId,
                details: { exitCode },
              })
            );
            return;
          }
          succeed({
            queryId,
            stdout: Buffer.concat(stdout, stdoutState.size),
            stderr: Buffer.concat(stderr, stderrState.size),
            exitCode,
          });
          return;
        }
        if (stdoutState.size !== 0) {
          fail(
            new RelayMysqlError('runner', 'Relay runner returned an invalid error response', {
              queryId,
              details: { exitCode },
            })
          );
          return;
        }
        fail(parseRunnerError(Buffer.concat(stderr, stderrState.size), queryId, exitCode));
      });
      child.stdin.on('error', () => {
        // Prefer the structured stderr/exit status emitted by the runner.
      });

      watchdog = setTimeout(() => {
        terminateChild();
        fail(new RelayMysqlError('timeout', 'Relay query exceeded its local timeout', { queryId }));
      }, timeoutMs + LOCAL_WATCHDOG_GRACE_MS);
      watchdog.unref?.();

      // Register every child-process listener before honoring cancellation.
      // spawn(2) failures are emitted asynchronously, so a pre-aborted signal
      // must not let us return while the ChildProcess has no `error` listener.
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      child.stdin.end(String(options.sql), 'utf8');
    });
  }
}

module.exports = {
  DEFAULT_STDOUT_LIMIT,
  DEFAULT_STDERR_LIMIT,
  DEFAULT_TIMEOUT_MS,
  LOCAL_WATCHDOG_GRACE_MS,
  TERMINATION_GRACE_MS,
  RunnerClient,
  SAFE_RUNNER_MESSAGES,
  parseRunnerError,
};
