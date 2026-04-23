'use strict';

const jwt = require('jsonwebtoken');
const { createHash } = require('crypto');
const { PLUGIN_NAME } = require('./constants');

const SESSION_AUDIENCE = 'openclaw-gateway-client';
const SESSION_SUBJECT = 'openclaw-session';

function createApiAuth(bootstrapToken, sessionSecret, sessionTtlSeconds = 300) {
  const ttl = normalizeTtl(sessionTtlSeconds);

  function extractBearerToken(req) {
    const header = req?.headers?.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    return header.substring(7);
  }

  function isBootstrapToken(token) {
    return Boolean(token) && token === bootstrapToken;
  }

  function issueSessionToken(meta = {}) {
    return jwt.sign({
      scope: 'api',
      bootstrap_fingerprint: fingerprintToken(bootstrapToken),
      client_name: meta.clientName || 'openclaw',
    }, sessionSecret, {
      expiresIn: ttl,
      issuer: PLUGIN_NAME,
      audience: SESSION_AUDIENCE,
      subject: SESSION_SUBJECT,
    });
  }

  function verifySessionToken(token) {
    return jwt.verify(token, sessionSecret, {
      issuer: PLUGIN_NAME,
      audience: SESSION_AUDIENCE,
      subject: SESSION_SUBJECT,
    });
  }

  function requireBootstrap(req, res, next) {
    const token = extractBearerToken(req);
    if (!isBootstrapToken(token)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing bootstrap Bearer token.',
      });
    }
    req.auth = { type: 'bootstrap' };
    next();
  }

  function requireSession(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing session Bearer token. Exchange the bootstrap token at POST /api/auth/session first.',
      });
    }
    try {
      req.auth = { type: 'session', claims: verifySessionToken(token) };
      next();
    } catch (err) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Invalid or expired session token: ${err.message}`,
      });
    }
  }

  function requireBootstrapOrSession(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing Bearer token.',
      });
    }
    if (isBootstrapToken(token)) {
      req.auth = { type: 'bootstrap' };
      return next();
    }
    try {
      req.auth = { type: 'session', claims: verifySessionToken(token) };
      return next();
    } catch (err) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `Invalid bootstrap or session token: ${err.message}`,
      });
    }
  }

  return {
    sessionTtlSeconds: ttl,
    issueSessionToken,
    requireBootstrap,
    requireSession,
    requireBootstrapOrSession,
    extractBearerToken,
  };
}

function fingerprintToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl)) return 300;
  return Math.max(60, Math.min(3600, Math.floor(ttl)));
}

module.exports = {
  createApiAuth,
  normalizeTtl,
};
