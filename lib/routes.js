'use strict';

const { PLUGIN_NAME, VERSION } = require('./constants');
const { normalizeRoomName, normalizeRoomKey } = require('./room-store');
const { parseAccessories, resolveAction } = require('./devices');
const { formatEventDescription } = require('./events');
const { buildSkillContent, buildGarageTriggerContent, buildClaudeMdAddition } = require('./setup-bundle');

function setupRoutes(app, apiToken, uiClient, roomStore, eventQueue, apiConfig) {
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ') || h.substring(7) !== apiToken) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing Bearer token.' });
    }
    next();
  }

  // Health (no auth)
  app.get('/health', async (_req, res) => {
    let deviceCount = 0;
    let connected = false;
    try {
      const raw = await uiClient.getAccessories();
      deviceCount = parseAccessories(raw, roomStore).length;
      connected = true;
    } catch (_) { /* silent */ }
    res.json({
      status: connected ? 'ok' : 'degraded',
      plugin: PLUGIN_NAME,
      version: VERSION,
      timestamp: new Date().toISOString(),
      devices: deviceCount,
      rooms: roomStore.listRooms().length,
    });
  });

  // Devices
  app.get('/api/devices', auth, async (_req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw, roomStore);
      res.json({ success: true, count: devices.length, devices });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  app.get('/api/devices/type/:type', auth, async (req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw, roomStore).filter(d => d.type === req.params.type.toLowerCase());
      res.json({ success: true, count: devices.length, devices });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  app.get('/api/devices/:id', auth, async (req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const device = parseAccessories(raw, roomStore).find(d => d.id === req.params.id);
      if (!device) return res.status(404).json({ error: 'Not Found', message: `Device '${req.params.id}' not found.` });
      res.json({ success: true, device });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  // Rooms
  app.get('/api/rooms', auth, async (_req, res) => {
    try {
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw, roomStore);
      res.json({ success: true, count: roomStore.listRooms(devices).length, rooms: roomStore.listRooms(devices) });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  app.get('/api/rooms/:room/devices', auth, async (req, res) => {
    try {
      const room = normalizeRoomName(req.params.room);
      const roomKey = normalizeRoomKey(room);
      const raw = await uiClient.getAccessories();
      const devices = parseAccessories(raw, roomStore).filter(d => normalizeRoomKey(d.room) === roomKey);
      res.json({ success: true, room, count: devices.length, devices });
    } catch (err) {
      res.status(502).json({ error: 'Upstream error', message: err.message });
    }
  });

  app.post('/api/rooms/learn', auth, async (req, res) => {
    const body = req.body || {};
    const assignments = [];
    if (Array.isArray(body.devices)) {
      for (const item of body.devices) assignments.push({ id: item?.id, room: item?.room });
    }
    if (body.rooms && typeof body.rooms === 'object') {
      for (const [room, ids] of Object.entries(body.rooms)) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids) assignments.push({ id, room });
      }
    }
    if (assignments.length === 0) {
      return res.status(400).json({ error: 'Bad Request', message: 'Expected "devices" array or "rooms" object.' });
    }
    let validIds;
    try {
      const raw = await uiClient.getAccessories();
      validIds = new Set(parseAccessories(raw, roomStore).map(d => d.id));
    } catch (err) {
      return res.status(502).json({ error: 'Upstream error', message: err.message });
    }
    const results = [];
    for (const item of assignments) {
      const id = item?.id;
      const room = normalizeRoomName(item?.room);
      if (!id) { results.push({ id, success: false, error: 'Missing device id.' }); continue; }
      if (!room) { results.push({ id, success: false, error: 'Missing room.' }); continue; }
      if (!validIds.has(id)) { results.push({ id, success: false, error: `Device '${id}' not found.` }); continue; }
      try {
        const entry = roomStore.setRoom(id, room);
        results.push({ id, success: true, room: entry.room });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  });

  // Room assignment on individual devices
  app.post('/api/devices/:id/room', auth, async (req, res) => {
    const room = normalizeRoomName(req.body?.room);
    if (!room) return res.status(400).json({ error: 'Bad Request', message: 'Missing "room".' });
    let devices;
    try {
      const raw = await uiClient.getAccessories();
      devices = parseAccessories(raw, roomStore);
    } catch (err) {
      return res.status(502).json({ error: 'Upstream error', message: err.message });
    }
    const device = devices.find(d => d.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'Not Found', message: `Device '${req.params.id}' not found.` });
    try {
      const entry = roomStore.setRoom(req.params.id, room);
      res.json({ success: true, id: req.params.id, room: entry.room });
    } catch (err) {
      res.status(500).json({ error: 'Room memory error', message: err.message });
    }
  });

  app.delete('/api/devices/:id/room', auth, async (req, res) => {
    try {
      roomStore.clearRoom(req.params.id);
      res.json({ success: true, id: req.params.id, room: null });
    } catch (err) {
      res.status(500).json({ error: 'Room memory error', message: err.message });
    }
  });

  // Device control
  app.post('/api/devices/:id/control', auth, async (req, res) => {
    const { action, value } = req.body || {};
    if (!action) return res.status(400).json({ error: 'Bad Request', message: 'Missing "action".' });
    const resolved = resolveAction(action, value);
    if (!resolved) return res.status(400).json({ error: 'Bad Request', message: `Unknown action: ${action}.` });
    try {
      const ops = Array.isArray(resolved) ? resolved : [resolved];
      const results = [];
      for (const op of ops) results.push(await uiClient.setCharacteristic(req.params.id, op.characteristicType, op.value));
      res.json({ success: true, id: req.params.id, action, results });
    } catch (err) {
      res.status(502).json({ error: 'Control error', message: err.message });
    }
  });

  app.post('/api/devices/control', auth, async (req, res) => {
    const { devices } = req.body || {};
    if (!Array.isArray(devices)) return res.status(400).json({ error: 'Bad Request', message: 'Expected "devices" array.' });
    const results = [];
    for (const item of devices) {
      const resolved = resolveAction(item.action, item.value);
      if (!resolved) { results.push({ id: item.id, success: false, error: `Unknown action: ${item.action}` }); continue; }
      try {
        const ops = Array.isArray(resolved) ? resolved : [resolved];
        for (const op of ops) await uiClient.setCharacteristic(item.id, op.characteristicType, op.value);
        results.push({ id: item.id, success: true });
      } catch (err) {
        results.push({ id: item.id, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  });

  // Events
  app.get('/api/events', auth, (req, res) => {
    const { since, priority = null } = req.query;
    if (!since) return res.status(400).json({ error: 'Bad Request', message: 'Missing "since" query parameter (unix ms).' });
    const cursor = Date.now();
    const events = eventQueue.since(since, priority);
    res.json({ cursor, count: events.length, events });
  });

  app.get('/api/events/summary', auth, (req, res) => {
    const { since } = req.query;
    if (!since) return res.status(400).json({ error: 'Bad Request', message: 'Missing "since" query parameter (unix ms).' });
    const cursor = Date.now();
    const events = eventQueue.since(since);
    const has_high_priority = events.some(e => e.priority === 'high');
    const summary = events.map(formatEventDescription).join(', ');
    res.json({ cursor, has_high_priority, summary });
  });

  // Setup bundle
  app.get('/api/setup', auth, (_req, res) => {
    const { externalUrl } = apiConfig;
    res.json({
      version: '1.0',
      plugin: PLUGIN_NAME,
      skills: [{ name: 'homekit-events', path: '.claude/commands/homekit-events.md', content: buildSkillContent(externalUrl, apiToken) }],
      triggers: [{ path: '.claude/homekit-triggers/garage-door-open.md', content: buildGarageTriggerContent(externalUrl, apiToken) }],
      cron: { schedule: '* * * * *', command: '/homekit-events', description: 'Poll HomeKit for state changes every minute' },
      claude_md_addition: buildClaudeMdAddition(externalUrl),
      env: { OPENCLAW_HB_URL: externalUrl, OPENCLAW_HB_TOKEN: apiToken },
    });
  });
}

module.exports = { setupRoutes };
