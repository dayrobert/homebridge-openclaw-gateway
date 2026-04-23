'use strict';

const { detectStoragePath, resolveApiToken } = require('../lib/storage');
const { UiClient } = require('../lib/ui-client');
const { startApiServer } = require('../lib/server');

function createConsoleLog() {
  return {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: (...args) => {
      if (process.env.DEBUG) console.debug(...args);
    },
  };
}

function envNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const log = createConsoleLog();
  const storagePath = process.env.UIX_STORAGE_PATH || detectStoragePath();
  const config = {
    apiPort: envNumber('OPENCLAW_API_PORT', 8865),
    apiBind: process.env.OPENCLAW_API_BIND || '127.0.0.1',
    token: process.env.OPENCLAW_HB_TOKEN,
    sessionTokenTtl: envNumber('OPENCLAW_SESSION_TTL', 300),
    rateLimit: envNumber('OPENCLAW_RATE_LIMIT', 100),
    pollInterval: envNumber('OPENCLAW_POLL_INTERVAL', 30),
    eventQueueSize: envNumber('OPENCLAW_EVENT_QUEUE_SIZE', 200),
    pluginExternalUrl: process.env.OPENCLAW_EXTERNAL_URL,
    homebridgeUiUrl: process.env.HOMEBRIDGE_UI_URL,
    homebridgeUiUser: process.env.HOMEBRIDGE_UI_USER,
    homebridgeUiPass: process.env.HOMEBRIDGE_UI_PASS,
  };

  const { token: apiToken } = resolveApiToken(config, storagePath, log);
  const uiClient = new UiClient({
    storagePath,
    uiUrl: config.homebridgeUiUrl,
    uiUser: config.homebridgeUiUser,
    uiPass: config.homebridgeUiPass,
    log,
  });

  await startApiServer({
    config,
    log,
    storagePath,
    apiToken,
    uiClient,
  });
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
