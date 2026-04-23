/**
 * homebridge-openclaw v3.0.0
 *
 * Exposes a simplified REST API so that an OpenClaw agent can list and
 * control HomeKit devices managed by Homebridge. Also runs an internal
 * state poller that detects HomeKit changes and feeds a lightweight event
 * queue, enabling OpenClaw to receive push-style notifications with minimal
 * token cost.
 *
 * Security:
 *   - Authenticates with Config UI X internally via JWT (no plaintext
 *     passwords in config.json). Reads .uix-secrets + auth.json directly.
 *   - API token resolved from: env var → file → config → auto-generated.
 *   - Rate-limited. Bind address configurable.
 *
 * Requirements:
 *   - homebridge-config-ui-x (comes with the official Docker image)
 *   - Homebridge started with -I flag (insecure mode)
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { PLUGIN_NAME, ACCESSORY_NAME, DEFAULT_PORT, DEFAULT_BIND, DEFAULT_RATE_LIMIT, ROOMS_FILE_NAME } = require('./lib/constants');
const { detectStoragePath, resolveApiToken } = require('./lib/storage');
const { RoomStore, normalizeRoomName, normalizeRoomKey } = require('./lib/room-store');
const { UiClient } = require('./lib/ui-client');
const { parseAccessories, mapType, resolveAction, clamp } = require('./lib/devices');
const { EventQueue, classifyPriority, diffSnapshot, formatEventDescription } = require('./lib/events');
const { setupRoutes } = require('./lib/routes');

// ─── Homebridge registration ─────────────────────────────────────────────────

module.exports = function (api) {
  api.registerPlatform(PLUGIN_NAME, ACCESSORY_NAME, OpenClawPlatform);
};

class OpenClawPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.name = config.name || 'OpenClaw API';

    const storagePath = detectStoragePath();
    this.storagePath = storagePath;

    const { token: apiToken } = resolveApiToken(config, storagePath, log);
    this.apiToken = apiToken;

    this.uiClient = new UiClient({
      storagePath,
      uiUrl: config.homebridgeUiUrl,
      uiUser: config.homebridgeUiUser,
      uiPass: config.homebridgeUiPass,
      log,
    });

    api.on('didFinishLaunching', () => this._startServer());
  }

  async _startServer() {
    const port = this.config.apiPort || DEFAULT_PORT;
    const bind = this.config.apiBind || DEFAULT_BIND;
    const rpmLimit = this.config.rateLimit || DEFAULT_RATE_LIMIT;

    try {
      await this.uiClient.token();
      this.log.info(`[${PLUGIN_NAME}] Connected to Config UI X (${this.uiClient.authMode}).`);
    } catch (err) {
      this.log.error(`[${PLUGIN_NAME}] Config UI X auth failed: ${err.message}`);
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

    const roomStore = new RoomStore(this.storagePath, this.log);

    // Event framework: in-memory queue populated by an internal state poller
    const eventQueue = new EventQueue(this.config.eventQueueSize || 200);
    let lastSnapshot = new Map();

    const primeAndPoll = async () => {
      try {
        const raw = await this.uiClient.getAccessories();
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
        lastSnapshot = new Map(devices.map(d => [d.id, d]));
      } catch (err) {
        this.log.debug(`[${PLUGIN_NAME}] State poll error: ${err.message}`);
      }
    };

    await primeAndPoll();
    this.log.info(`[${PLUGIN_NAME}] Event poller started (interval: ${this.config.pollInterval || 30}s, queue: ${this.config.eventQueueSize || 200}).`);

    const pollMs = Math.max(10, Math.min(300, this.config.pollInterval || 30)) * 1000;
    const pollTimer = setInterval(primeAndPoll, pollMs);
    pollTimer.unref();

    const externalUrl = (this.config.pluginExternalUrl || `http://localhost:${port}`).replace(/\/+$/, '');
    setupRoutes(app, this.apiToken, this.uiClient, roomStore, eventQueue, { externalUrl });

    const server = app.listen(port, bind, () => {
      this.log.info(`[${PLUGIN_NAME}] REST API listening on ${bind}:${port}`);
    });
    server.on('error', err => {
      this.log.error(`[${PLUGIN_NAME}] Server error: ${err.message}`);
    });
  }
}

// ─── Test surface ────────────────────────────────────────────────────────────

module.exports._test = {
  RoomStore, normalizeRoomName, normalizeRoomKey, ROOMS_FILE_NAME,
  parseAccessories, mapType, resolveAction, clamp,
  EventQueue, classifyPriority, diffSnapshot, formatEventDescription,
  setupRoutes,
};
