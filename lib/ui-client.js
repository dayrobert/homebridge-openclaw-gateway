'use strict';

const { readFileSync } = require('fs');
const { resolve } = require('path');
const { createHash } = require('crypto');
const jwt = require('jsonwebtoken');
const { PLUGIN_NAME, DEFAULT_UI_URL } = require('./constants');

class UiClient {
  constructor({ storagePath, uiUrl, uiUser, uiPass, log }) {
    this.storagePath = storagePath;
    this.baseUrl = (uiUrl || DEFAULT_UI_URL).replace(/\/+$/, '');
    this.uiUser = uiUser || null;
    this.uiPass = uiPass || null;
    this.log = log;
    this.jwt = null;
    this.jwtExpires = 0;
    this.secretKey = null;
    this.adminUser = null;
    this.instanceId = null;
    this.authMode = 'none'; // 'jwt-direct' | 'login' | 'none'
    this._detectAuthMode();
  }

  _detectAuthMode() {
    try {
      const secrets = JSON.parse(readFileSync(resolve(this.storagePath, '.uix-secrets'), 'utf8'));
      if (secrets.secretKey) {
        this.secretKey = secrets.secretKey;
        this.instanceId = createHash('sha256').update(secrets.secretKey).digest('hex');
      }
    } catch (_) { /* not available */ }

    try {
      const users = JSON.parse(readFileSync(resolve(this.storagePath, 'auth.json'), 'utf8'));
      const admin = Array.isArray(users) ? users.find(u => u.admin) : null;
      if (admin) this.adminUser = admin.username;
    } catch (_) { /* not available */ }

    if (this.secretKey && this.adminUser) {
      this.authMode = 'jwt-direct';
      this.log.info(`[${PLUGIN_NAME}] Auth mode: JWT direct (no password needed).`);
    } else if (this.uiUser && this.uiPass) {
      this.authMode = 'login';
      this.log.info(`[${PLUGIN_NAME}] Auth mode: login (credentials from config).`);
    } else {
      this.log.error(`[${PLUGIN_NAME}] Auth mode: none — cannot authenticate with Config UI X!`);
      this.log.error(`[${PLUGIN_NAME}] Ensure .uix-secrets exists or provide homebridgeUiUser/homebridgeUiPass.`);
    }
  }

  _signJwt() {
    return jwt.sign(
      { username: this.adminUser, name: this.adminUser, admin: true, instanceId: this.instanceId },
      this.secretKey,
      { expiresIn: '8h' },
    );
  }

  async token() {
    if (this.authMode === 'jwt-direct') {
      if (!this.jwt || Date.now() >= this.jwtExpires) {
        this.jwt = this._signJwt();
        this.jwtExpires = Date.now() + 7 * 3600 * 1000;
      }
      return this.jwt;
    }
    if (this.authMode === 'login') {
      if (!this.jwt || Date.now() >= this.jwtExpires) await this._loginAuth();
      return this.jwt;
    }
    throw new Error('No authentication method available for Config UI X.');
  }

  async _loginAuth() {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.uiUser, password: this.uiPass, otp: '' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Config UI login failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.jwt = data.access_token;
    this.jwtExpires = Date.now() + ((data.expires_in || 28800) - 60) * 1000;
  }

  async getAccessories() {
    const tok = await this.token();
    const res = await fetch(`${this.baseUrl}/api/accessories`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET /api/accessories → ${res.status}`);
    return res.json();
  }

  async setCharacteristic(uniqueId, characteristicType, value) {
    const tok = await this.token();
    const res = await fetch(`${this.baseUrl}/api/accessories/${encodeURIComponent(uniqueId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ characteristicType, value }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PUT ${characteristicType} → ${res.status}: ${text}`);
    }
    return res.json();
  }
}

module.exports = { UiClient };
