'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { createHmac } = require('crypto');
const { resolve } = require('path');
const { PLUGIN_NAME, TOKEN_FILE_NAME, TOKEN_ENV_VAR } = require('./constants');

function detectStoragePath() {
  if (process.env.UIX_STORAGE_PATH) return process.env.UIX_STORAGE_PATH;
  const candidates = [
    '/var/lib/homebridge',
    resolve(require('os').homedir(), '.homebridge'),
  ];
  for (const p of candidates) {
    if (existsSync(resolve(p, '.uix-secrets'))) return p;
  }
  return candidates[0];
}

function resolveApiToken(config, storagePath, log) {
  if (process.env[TOKEN_ENV_VAR]) {
    log.info(`[${PLUGIN_NAME}] API token loaded from environment variable ${TOKEN_ENV_VAR}.`);
    return { token: process.env[TOKEN_ENV_VAR], source: 'env' };
  }

  const tokenFilePath = resolve(storagePath, TOKEN_FILE_NAME);
  if (existsSync(tokenFilePath)) {
    try {
      const fileToken = readFileSync(tokenFilePath, 'utf8').trim();
      if (fileToken.length >= 16) {
        log.info(`[${PLUGIN_NAME}] API token loaded from ${tokenFilePath}.`);
        return { token: fileToken, source: 'file' };
      }
    } catch (_) { /* fall through */ }
  }

  if (config.token && config.token.length >= 8) {
    log.info(`[${PLUGIN_NAME}] API token loaded from config.json.`);
    return { token: config.token, source: 'config' };
  }

  let secretKey = 'openclaw-default-seed';
  try {
    const secrets = JSON.parse(readFileSync(resolve(storagePath, '.uix-secrets'), 'utf8'));
    if (secrets.secretKey) secretKey = secrets.secretKey;
  } catch (_) { /* use default seed */ }

  const generated = createHmac('sha256', secretKey).update('openclaw-hb-api-token').digest('hex').slice(0, 48);

  try {
    writeFileSync(tokenFilePath, generated + '\n', { mode: 0o600 });
    log.info(`[${PLUGIN_NAME}] API token auto-generated and saved to ${tokenFilePath}.`);
  } catch (err) {
    log.warn(`[${PLUGIN_NAME}] Could not write token file: ${err.message}. Token only in logs.`);
  }

  log.info(`[${PLUGIN_NAME}] ────────────────────────────────────────`);
  log.info(`[${PLUGIN_NAME}] API Token: ${generated}`);
  log.info(`[${PLUGIN_NAME}] Configure this token in your OpenClaw agent.`);
  log.info(`[${PLUGIN_NAME}] ────────────────────────────────────────`);

  return { token: generated, source: 'auto' };
}

module.exports = { detectStoragePath, resolveApiToken };
