'use strict';

const http = require('node:http');

const marker = Symbol.for('dbgate-relay-mysql.loopback-installed');

if (!http.Server.prototype[marker]) {
  const originalListen = http.Server.prototype.listen;

  http.Server.prototype.listen = function listenOnLoopback(...args) {
    if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) {
      args.splice(1, 0, '127.0.0.1');
    }
    return originalListen.apply(this, args);
  };

  Object.defineProperty(http.Server.prototype, marker, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

