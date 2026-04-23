'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  PLUGIN_NAME,
  DEFAULT_PORT,
  DEFAULT_BIND,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SESSION_TTL,
} = require('./constants');
const { createApiAuth } = require('./auth');
const { RoomStore } = require('./room-store');
const { parseAccessories } = require('./devices');
const {
  EventQueue,
  classifyPriority,
  diffSnapshot,
} = require('./events');
const { setupRoutes } = require('./routes');

async function startApiServer({
  config = {},
  log,
  storagePath,
  apiToken,
  uiClient,
}) {
  const port = config.apiPort || DEFAULT_PORT;
  const bind = config.apiBind || DEFAULT_BIND;
  const rpmLimit = config.rateLimit || DEFAULT_RATE_LIMIT;

  try {
    await uiClient.token();
    log.info(`[${PLUGIN_NAME}] Connected to Config UI X (${uiClient.authMode}).`);
  } catch (err) {
    log.error(`[${PLUGIN_NAME}] Config UI X auth failed: ${err.message}`);
  }

  const app = express();
  app.use(express.json());
  app.set('trust proxy', 1);
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: rpmLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too Many Requests', message: `Rate limit: ${rpmLimit} requests per minute.` },
  }));

  const roomStore = new RoomStore(storagePath, log);
  const eventQueue = new EventQueue(config.eventQueueSize || 200);
  let lastSnapshot = new Map();

  const primeAndPoll = async () => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw, roomStore);
      const diffs = diffSnapshot(lastSnapshot, devices);
      for (const { device, changes } of diffs) {
        eventQueue.push({
          id: device.id,
          name: device.name,
          type: device.type,
          room: device.room,
          changes,
          priority: classifyPriority(device, changes),
        });
      }
      lastSnapshot = new Map(devices.map(device => [device.id, device]));
    } catch (err) {
      log.debug(`[${PLUGIN_NAME}] State poll error: ${err.message}`);
    }
  };

  await primeAndPoll();
  log.info(`[${PLUGIN_NAME}] Event poller started (interval: ${config.pollInterval || 30}s, queue: ${config.eventQueueSize || 200}).`);

  const pollMs = Math.max(10, Math.min(300, config.pollInterval || 30)) * 1000;
  const pollTimer = setInterval(primeAndPoll, pollMs);
  pollTimer.unref();

  const externalUrl = (config.pluginExternalUrl || `http://localhost:${port}`).replace(/\/+$/, '');
  const apiAuth = createApiAuth(apiToken, apiToken, config.sessionTokenTtl || DEFAULT_SESSION_TTL);
  setupRoutes(app, apiAuth, uiClient, roomStore, eventQueue, {
    externalUrl,
    bootstrapToken: apiToken,
  });

  const server = app.listen(port, bind, () => {
    log.info(`[${PLUGIN_NAME}] REST API listening on ${bind}:${port}`);
  });
  server.on('error', err => {
    log.error(`[${PLUGIN_NAME}] Server error: ${err.message}`);
  });

  return { app, server, roomStore, eventQueue };
}

module.exports = { startApiServer };
