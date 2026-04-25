/**
 * homebridge-openclaw-gateway v3.1.2
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
 *   - Bootstrap token resolved from: env var → file → config → auto-generated.
 *   - Operational API access uses short-lived signed session tokens.
 *   - Rate-limited. Bind address configurable.
 *
 * Requirements:
 *   - homebridge-config-ui-x (comes with the official Docker image)
 *   - Homebridge started with -I flag (insecure mode)
 */

'use strict';

const { PLUGIN_NAME, ACCESSORY_NAME, ROOMS_FILE_NAME } = require('./lib/constants');
const { detectStoragePath, resolveApiToken } = require('./lib/storage');
const { RoomStore, normalizeRoomName, normalizeRoomKey } = require('./lib/room-store');
const { UiClient } = require('./lib/ui-client');
const { parseAccessories, mapType, resolveAction, clamp } = require('./lib/devices');
const { EventQueue, classifyPriority, diffSnapshot, formatEventDescription } = require('./lib/events');
const { createEventSink, normalizeEventSource, normalizeSubscribeTypes, getHapCharacteristicTypes } = require('./lib/event-sources');
const { createApiAuth } = require('./lib/auth');
const { setupRoutes } = require('./lib/routes');
const { startApiServer } = require('./lib/server');

// ─── Homebridge registration ─────────────────────────────────────────────────

module.exports = function (api) {
  api.registerPlatform(PLUGIN_NAME, ACCESSORY_NAME, OpenClawPlatform);
};

class OpenClawPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.name = config.name || 'OpenClaw Gateway';

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
    await startApiServer({
      config: this.config,
      log: this.log,
      storagePath: this.storagePath,
      apiToken: this.apiToken,
      uiClient: this.uiClient,
    });
  }
}

// ─── Test surface ────────────────────────────────────────────────────────────

module.exports._test = {
  RoomStore, normalizeRoomName, normalizeRoomKey, ROOMS_FILE_NAME,
  parseAccessories, mapType, resolveAction, clamp,
  EventQueue, classifyPriority, diffSnapshot, formatEventDescription,
  createEventSink, normalizeEventSource, normalizeSubscribeTypes, getHapCharacteristicTypes,
  createApiAuth,
  setupRoutes,
};
