'use strict';

const crypto = require('node:crypto');
const { loadProfile } = require('../runner/profile-store');
const { PersistentSession } = require('./persistent-session');

const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

function profileFingerprint(profile) {
  return crypto.createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

class SessionManager {
  constructor(options = {}) {
    this.environment = options.environment || process.env;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.now = options.now || Date.now;
    this.createSession = options.createSession || ((profile, sessionOptions) => new PersistentSession(profile, sessionOptions));
    this.sessions = new Map();
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), Math.min(30_000, this.idleTtlMs));
    this.cleanupTimer.unref?.();
  }

  execute(request) {
    const profile = loadProfile(request.profile, {
      filePath: request.profileFile,
      env: this.environment,
    });
    const key = profileFingerprint(profile);
    let session = this.sessions.get(key);
    if (!session || session.dead) {
      session = this.createSession(profile, {
        sourceEnvironment: this.environment,
        onDead: deadSession => {
          if (this.sessions.get(key) === deadSession) this.sessions.delete(key);
        },
      });
      this.sessions.set(key, session);
    }
    return session.execute(request);
  }

  cleanupIdle() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.isIdle(now, this.idleTtlMs)) session.destroy();
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { DEFAULT_SESSION_IDLE_TTL_MS, SessionManager, profileFingerprint };
