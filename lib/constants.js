'use strict';

const PLUGIN_NAME = 'homebridge-openclaw-gateway';
const ACCESSORY_NAME = 'OpenClawGateway';
const VERSION = '3.1.1';
const DEFAULT_PORT = 8865;
const DEFAULT_BIND = '0.0.0.0';
const DEFAULT_RATE_LIMIT = 100;
const DEFAULT_SESSION_TTL = 300;
const DEFAULT_UI_URL = 'http://localhost:8581';
const TOKEN_FILE_NAME = '.openclaw-token';
const ROOMS_FILE_NAME = '.openclaw-rooms.json';
const TOKEN_ENV_VAR = 'OPENCLAW_HB_TOKEN';

module.exports = {
  PLUGIN_NAME, ACCESSORY_NAME, VERSION,
  DEFAULT_PORT, DEFAULT_BIND, DEFAULT_RATE_LIMIT, DEFAULT_SESSION_TTL, DEFAULT_UI_URL,
  TOKEN_FILE_NAME, ROOMS_FILE_NAME, TOKEN_ENV_VAR,
};
