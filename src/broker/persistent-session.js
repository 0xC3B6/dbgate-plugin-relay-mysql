'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RelayMysqlError } = require('../backend/errors');
const { BufferLimitError } = require('../runner/bounded-buffer');
const { EXIT_CODES, MAX_RESULT_BYTES } = require('../runner/constants');
const { buildRemoteScript } = require('../runner/remote-script');
const { sanitizedEnvironment, terminateProcessGroup } = require('../runner/cli');
const { encodeSessionRequest, encodeSessionStartup } = require('../runner/session-frame-codec');
const { SessionResultParser } = require('./session-result-parser');

const READY_MARKER = Buffer.from('__DBGATE_SESSION_READY__\n');

function locateSessionExpectScript() {
  const candidates = [
    path.resolve(__dirname, '../../runner/relay-mysql-session.exp'),
    path.resolve(__dirname, '../runner/relay-mysql-session.exp'),
    path.resolve(process.cwd(), 'runner/relay-mysql-session.exp'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Persistent Expect adapter is unavailable');
  return found;
}

function categoryForExitCode(code) {
  return Object.keys(EXIT_CODES).find(key => EXIT_CODES[key] === code && key !== 'result_too_large') || 'runner';
}

class PersistentSession {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.spawn = options.spawn || spawn;
    this.expectPath = options.expectPath || '/usr/bin/expect';
    this.expectScript = options.expectScript || locateSessionExpectScript();
    this.sourceEnvironment = options.sourceEnvironment || process.env;
    this.maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES;
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.onDead = options.onDead || (() => {});
    this.queue = [];
    this.child = null;
    this.current = null;
    this.ready = false;
    this.readyBuffer = Buffer.alloc(0);
    this.dead = false;
    this.lastUsedAt = Date.now();
  }

  execute(request) {
    return new Promise((resolve, reject) => {
      const item = { request, resolve, reject, cancelled: false, abort: null, timer: null };
      item.abort = () => {
        if (item.cancelled) return;
        item.cancelled = true;
        reject(new RelayMysqlError('runner', 'Relay query was cancelled locally', { queryId: request.requestId }));
        if (this.current === item) this.destroy('runner');
      };
      request.signal?.addEventListener('abort', item.abort, { once: true });
      if (request.signal?.aborted) {
        item.abort();
        return;
      }
      this.queue.push(item);
      this.pump();
    });
  }

  pump() {
    if (this.dead || this.current) return;
    while (this.queue[0]?.cancelled) this.queue.shift();
    const item = this.queue.shift();
    if (!item) return;
    this.current = item;
    item.timer = setTimeout(() => {
      if (item.cancelled) return;
      item.cancelled = true;
      item.reject(new RelayMysqlError('timeout', 'Relay query exceeded its deadline', { queryId: item.request.requestId }));
      this.destroy('timeout');
    }, item.request.timeoutMs);
    item.timer.unref?.();

    try {
      if (!this.child) this.start();
      if (this.ready) this.sendCurrent();
    } catch (_error) {
      this.failAll('runner');
    }
  }

  start() {
    this.child = this.spawn(this.expectPath, ['-f', this.expectScript], {
      detached: true,
      env: sanitizedEnvironment(this.profile, this.sourceEnvironment),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => this.failAll('runner'));
    this.child.on('close', code => {
      if (!this.dead) this.failAll(categoryForExitCode(code));
    });
    this.child.stdin.write(encodeSessionStartup(this.profile, buildRemoteScript()));
  }

  onStdout(chunk) {
    if (this.dead) return;
    if (!this.ready) {
      this.readyBuffer = Buffer.concat([this.readyBuffer, Buffer.from(chunk)]);
      const index = this.readyBuffer.indexOf(READY_MARKER);
      if (index < 0) {
        if (this.readyBuffer.length > READY_MARKER.length * 2) this.failAll('runner');
        return;
      }
      const remainder = this.readyBuffer.subarray(index + READY_MARKER.length);
      this.readyBuffer = Buffer.alloc(0);
      this.ready = true;
      this.sendCurrent();
      if (remainder.length) this.onStdout(remainder);
      return;
    }
    if (!this.current?.parser) {
      if (String(chunk).trim()) this.failAll('runner');
      return;
    }
    let result;
    try {
      result = this.current.parser.push(chunk);
    } catch (error) {
      this.failAll(error instanceof BufferLimitError ? 'result_too_large' : 'runner');
      return;
    }
    if (!result) return;
    const item = this.current;
    this.current = null;
    clearTimeout(item.timer);
    item.request.signal?.removeEventListener('abort', item.abort);
    this.lastUsedAt = Date.now();
    if (!item.cancelled) {
      if (result.category === 'OK') item.resolve(result.stdout);
      else item.reject(new RelayMysqlError(result.category, `Persistent Relay query failed`, { queryId: item.request.requestId }));
    }
    this.pump();
  }

  sendCurrent() {
    if (!this.ready || !this.current || this.current.parser || this.current.cancelled) return;
    const nonce = this.randomBytes(16).toString('hex');
    this.current.parser = new SessionResultParser({ nonce, maxBytes: this.maxResultBytes });
    this.child.stdin.write(encodeSessionRequest({
      nonce,
      database: this.current.request.database,
      sql: this.current.request.sql,
    }));
  }

  failAll(category) {
    if (this.dead) return;
    this.dead = true;
    const items = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    for (const item of items) {
      clearTimeout(item.timer);
      item.request.signal?.removeEventListener('abort', item.abort);
      if (!item.cancelled) {
        item.cancelled = true;
        item.reject(new RelayMysqlError(category, 'Persistent Relay session ended', { queryId: item.request.requestId }));
      }
    }
    terminateProcessGroup(this.child);
    this.onDead(this);
  }

  destroy(category = 'runner') {
    this.failAll(category);
  }

  isIdle(now, ttlMs) {
    return !this.current && this.queue.length === 0 && now - this.lastUsedAt >= ttlMs;
  }
}

module.exports = {
  PersistentSession,
  categoryForExitCode,
  locateSessionExpectScript,
};
