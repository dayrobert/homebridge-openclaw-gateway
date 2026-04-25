'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  PLUGIN_NAME,
  DEFAULT_PORT,
  DEFAULT_BIND,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SESSION_TTL,
  DEFAULT_EVENT_QUEUE_SIZE,
} = require('./constants');
const { createApiAuth } = require('./auth');
const { RoomStore } = require('./room-store');
const { EventQueue } = require('./events');
const { startEventSources } = require('./event-sources');
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
  const eventQueue = new EventQueue(config.eventQueueSize || DEFAULT_EVENT_QUEUE_SIZE);
  const eventSources = await startEventSources({
    config,
    uiClient,
    roomStore,
    eventQueue,
    log,
  });
  log.info(`[${PLUGIN_NAME}] Event sources started (mode: ${eventSources.mode}, queue: ${config.eventQueueSize || DEFAULT_EVENT_QUEUE_SIZE}).`);

  const externalUrl = (config.pluginExternalUrl || `http://localhost:${port}`).replace(/\/+$/, '');
  const apiAuth = createApiAuth(apiToken, apiToken, config.sessionTokenTtl || DEFAULT_SESSION_TTL);
  setupRoutes(app, apiAuth, uiClient, roomStore, eventQueue, {
    externalUrl,
    bootstrapToken: apiToken,
    getEventingStatus: () => eventSources.summary(),
  });

  const server = app.listen(port, bind, () => {
    log.info(`[${PLUGIN_NAME}] REST API listening on ${bind}:${port}`);
  });
  server.on('error', err => {
    log.error(`[${PLUGIN_NAME}] Server error: ${err.message}`);
  });
  server.on('close', () => {
    eventSources.stop();
  });

  return { app, server, roomStore, eventQueue, eventSources };
}

module.exports = { startApiServer };
