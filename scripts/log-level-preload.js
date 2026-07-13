'use strict';

// pinomin 1.0.5 exports only the numeric-to-name half of its level table,
// while its filter looks levels up by name. Fill in the reverse mapping so
// DbGate's CONSOLE_LOG_LEVEL/FILE_LOG_LEVEL settings actually take effect.
const pinomin = require('pinomin');
for (const [name, number] of Object.entries(pinomin.logLevelNumbers)) {
  pinomin.logLevelNames[name] = number;
}

// DbGate worker processes do not call configureLogger(), so they otherwise
// fall back to an info-level console logger even when the parent is set to
// warn. Give every fork a safe default; the API parent replaces this config
// with its console + file targets during normal startup.
const { setLogConfig } = require('dbgate-tools');
setLogConfig({
  base: { pid: process.pid },
  targets: [
    {
      type: 'console',
      level: process.env.CONSOLE_LOG_LEVEL || process.env.LOG_LEVEL || 'warn',
    },
  ],
});
