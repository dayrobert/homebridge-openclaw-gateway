const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');
const test = require('node:test');

function loadPluginForTest() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') {
      const express = () => ({
        get() {},
        post() {},
        delete() {},
        use() {},
        set() {},
        listen(_port, _bind, cb) {
          if (cb) cb();
          return { on() {} };
        },
      });
      express.json = () => (_req, _res, next) => next();
      return express;
    }
    if (request === 'express-rate-limit') {
      return () => (_req, _res, next) => next();
    }
    if (request === 'jsonwebtoken') {
      return {
        sign(payload, secret, options = {}) {
          return Buffer.from(JSON.stringify({ payload, secret, options }), 'utf8').toString('base64url');
        },
        verify(token, secret, options = {}) {
          const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
          if (parsed.secret !== secret) throw new Error('invalid signature');
          if (options.issuer && parsed.options.issuer !== options.issuer) throw new Error('jwt issuer invalid');
          if (options.audience && parsed.options.audience !== options.audience) throw new Error('jwt audience invalid');
          if (options.subject && parsed.options.subject !== options.subject) throw new Error('jwt subject invalid');
          return parsed.payload;
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../index.js')];
    return require('../index.js')._test;
  } finally {
    Module._load = originalLoad;
  }
}

const {
  RoomStore,
  normalizeRoomName,
  normalizeRoomKey,
  parseAccessories,
  mapType,
  resolveAction,
  clamp,
  createEventSink,
  normalizeEventSource,
  normalizeSubscribeTypes,
  getHapCharacteristicTypes,
  createApiAuth,
  setupRoutes,
  ROOMS_FILE_NAME,
} = loadPluginForTest();

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function makeRouteHarness() {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: 'POST', path, handlers });
    },
    delete(path, ...handlers) {
      routes.push({ method: 'DELETE', path, handlers });
    },
  };

  function findRoute(method, path) {
    return routes.find(route => route.method === method && route.path === path);
  }

  async function invoke(method, path, req) {
    const route = findRoute(method, path);
    assert.ok(route, `Expected ${method} ${path} to be registered.`);

    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };

    let index = 0;
    const next = async () => {
      const handler = route.handlers[index++];
      if (!handler) return;
      await handler(req, res, next);
    };

    await next();
    return res;
  }

  return { app, invoke };
}

function makeApiAuth(bootstrapToken = 'test-token') {
  return createApiAuth(bootstrapToken, bootstrapToken, 300);
}

function makeSessionHeaders(apiAuth) {
  return { authorization: `Bearer ${apiAuth.issueSessionToken({ clientName: 'test-suite' })}` };
}

test('normalizes room names by trimming and collapsing whitespace', () => {
  assert.equal(normalizeRoomName('  Living   Room  '), 'Living Room');
  assert.equal(normalizeRoomName(null), '');
  assert.equal(normalizeRoomKey('  Living   Room  '), 'living room');
});

test('RoomStore persists device room assignments', t => {
  const dir = makeTempDir(t);
  const firstStore = new RoomStore(dir, makeLog());

  const entry = firstStore.setRoom('device-1', '  Office  ');
  assert.equal(entry.room, 'Office');
  assert.equal(entry.roomKey, 'office');
  assert.match(entry.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const roomFile = join(dir, ROOMS_FILE_NAME);
  assert.equal(existsSync(roomFile), true);
  assert.deepEqual(JSON.parse(readFileSync(roomFile, 'utf8')).devices['device-1'].room, 'Office');
  assert.deepEqual(JSON.parse(readFileSync(roomFile, 'utf8')).devices['device-1'].roomKey, 'office');

  const secondStore = new RoomStore(dir, makeLog());
  assert.equal(secondStore.getRoom('device-1'), 'Office');
});

test('RoomStore clears rooms and lists rooms with stale devices', t => {
  const dir = makeTempDir(t);
  const store = new RoomStore(dir, makeLog());

  store.setRoom('light-1', 'Kitchen');
  store.setRoom('switch-1', 'Kitchen');
  store.setRoom('missing-1', 'Office');
  store.clearRoom('switch-1');

  assert.equal(store.getRoom('switch-1'), null);
  assert.deepEqual(store.listRooms([{ id: 'light-1', name: 'Ceiling Light', type: 'lightbulb' }]), [
    {
      name: 'Kitchen',
      count: 1,
      devices: [{ id: 'light-1', name: 'Ceiling Light', type: 'lightbulb' }],
    },
    {
      name: 'Office',
      count: 1,
      devices: [{ id: 'missing-1', stale: true }],
    },
  ]);
});

test('RoomStore groups room names case-insensitively', t => {
  const dir = makeTempDir(t);
  const store = new RoomStore(dir, makeLog());

  store.setRoom('light-1', 'Office');
  store.setRoom('light-2', 'office');

  assert.deepEqual(
    store.listRooms([
      { id: 'light-1', name: 'Lamp 1', type: 'lightbulb' },
      { id: 'light-2', name: 'Lamp 2', type: 'lightbulb' },
    ]),
    [
      {
        name: 'Office',
        count: 2,
        devices: [
          { id: 'light-1', name: 'Lamp 1', type: 'lightbulb' },
          { id: 'light-2', name: 'Lamp 2', type: 'lightbulb' },
        ],
      },
    ],
  );
});

test('RoomStore backfills old room memory files and groups by room key', t => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, ROOMS_FILE_NAME), JSON.stringify({
    version: 1,
    devices: {
      'light-1': { room: 'Office', updatedAt: '2026-01-01T00:00:00.000Z' },
      'fan-1': { room: ' office ', updatedAt: '2026-01-02T00:00:00.000Z' },
      'bad-1': { room: '   ', updatedAt: '2026-01-03T00:00:00.000Z' },
    },
  }));

  const store = new RoomStore(dir, makeLog());

  assert.deepEqual(store.data.devices, {
    'light-1': {
      room: 'Office',
      roomKey: 'office',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    'fan-1': {
      room: 'office',
      roomKey: 'office',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  });
  assert.deepEqual(store.listRooms([
    { id: 'light-1', name: 'Desk Lamp', type: 'lightbulb' },
    { id: 'fan-1', name: 'Office Fan', type: 'fan' },
  ]), [
    {
      name: 'Office',
      count: 2,
      devices: [
        { id: 'light-1', name: 'Desk Lamp', type: 'lightbulb' },
        { id: 'fan-1', name: 'Office Fan', type: 'fan' },
      ],
    },
  ]);
});

test('RoomStore tolerates corrupt room memory files', t => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, ROOMS_FILE_NAME), '{bad json');

  const warnings = [];
  const store = new RoomStore(dir, { ...makeLog(), warn: message => warnings.push(message) });

  assert.equal(store.getRoom('device-1'), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not read room memory/);
});

test('RoomStore applies bulk assignments with per-item errors', t => {
  const dir = makeTempDir(t);
  const store = new RoomStore(dir, makeLog());

  assert.deepEqual(store.applyAssignments([
    { id: 'light-1', room: 'Kitchen' },
    { id: '', room: 'Kitchen' },
    { id: 'switch-1', room: '' },
  ]), [
    { id: 'light-1', success: true, room: 'Kitchen' },
    { id: '', success: false, error: 'Missing device id.' },
    { id: 'switch-1', success: false, error: 'Missing room.' },
  ]);
});

test('parseAccessories maps services into device objects with learned rooms', () => {
  const roomStore = { getRoom: id => id === 'light-1' ? 'Office' : null };
  const devices = parseAccessories([
    {
      uniqueId: 'light-1',
      serviceName: 'Desk Lamp',
      humanType: 'Lightbulb',
      values: { On: true },
      serviceCharacteristics: [
        { type: 'On', canWrite: true },
        { type: 'CurrentAmbientLightLevel', canWrite: false },
      ],
      accessoryInformation: {
        Manufacturer: 'Acme',
        Model: 'A1',
      },
    },
    {
      uniqueId: 'info-1',
      serviceName: 'Info',
      humanType: 'AccessoryInformation',
    },
    {
      uniqueId: 'api-1',
      serviceName: 'OpenClaw Gateway',
      humanType: 'Switch',
    },
  ], roomStore);

  assert.deepEqual(devices, [
    {
      id: 'light-1',
      name: 'Desk Lamp',
      type: 'lightbulb',
      humanType: 'Lightbulb',
      room: 'Office',
      state: { On: true },
      characteristics: ['On'],
      manufacturer: 'Acme',
      model: 'A1',
    },
  ]);
});

test('mapType recognizes common HomeKit service names', () => {
  assert.equal(mapType('Lightbulb'), 'lightbulb');
  assert.equal(mapType('Window Covering'), 'blinds');
  assert.equal(mapType('Garage Door Opener'), 'garage');
  assert.equal(mapType('Humidity Sensor'), 'sensor');
  assert.equal(mapType('Something Else'), 'other');
});

test('resolveAction returns characteristic writes and clamps numeric values', () => {
  assert.deepEqual(resolveAction('on', true), { characteristicType: 'On', value: true });
  assert.deepEqual(resolveAction('brightness', 150), { characteristicType: 'Brightness', value: 100 });
  assert.deepEqual(resolveAction('tilt', -120), { characteristicType: 'TargetHorizontalTiltAngle', value: -90 });
  assert.deepEqual(resolveAction('mode', 'cool'), { characteristicType: 'TargetHeatingCoolingState', value: 2 });
  assert.deepEqual(resolveAction('color', { hue: 240, saturation: 90 }), [
    { characteristicType: 'Hue', value: 240 },
    { characteristicType: 'Saturation', value: 90 },
  ]);
  assert.equal(resolveAction('nope', true), null);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
});

test('event source helpers normalize modes and HAP subscribe types', () => {
  assert.equal(normalizeEventSource('HYBRID'), 'hybrid');
  assert.equal(normalizeEventSource('mystery'), 'poll');
  assert.deepEqual(normalizeSubscribeTypes(['garage', ' lock ', 'garage', '', null]), ['garage', 'lock']);
  assert.deepEqual(getHapCharacteristicTypes(['garage', 'contact', 'garage']), ['CurrentDoorState', 'ContactSensorState']);
});

test('event sink de-duplicates identical events within a short window', () => {
  const pushed = [];
  const sink = createEventSink({
    eventQueue: {
      push(event) {
        pushed.push(event);
      },
    },
    dedupeWindowMs: 5000,
  });

  assert.equal(sink.emit({ id: 'garage-1', changes: { CurrentDoorState: { from: 1, to: 0 } }, source: 'poll' }), true);
  assert.equal(sink.emit({ id: 'garage-1', changes: { CurrentDoorState: { from: 1, to: 0 } }, source: 'hap' }), false);
  assert.equal(sink.emit({ id: 'garage-1', changes: { CurrentDoorState: { from: 0, to: 1 } }, source: 'hap' }), true);
  assert.equal(pushed.length, 2);
});

test('POST /api/devices/:id/room returns 502 for upstream lookup failures', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth();
  setupRoutes(app, apiAuth, {
    async getAccessories() {
      throw new Error('Config UI unavailable');
    },
  }, {
    getRoom() {
      return null;
    },
    setRoom() {
      throw new Error('Should not write when upstream failed.');
    },
  });

  const res = await invoke('POST', '/api/devices/:id/room', {
    headers: makeSessionHeaders(apiAuth),
    params: { id: 'light-1' },
    body: { room: 'Office' },
  });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'Upstream error', message: 'Config UI unavailable' });
});

test('POST /api/devices/:id/room returns 500 for local room write failures', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth();
  setupRoutes(app, apiAuth, {
    async getAccessories() {
      return [{ uniqueId: 'light-1', serviceName: 'Desk Lamp', humanType: 'Lightbulb' }];
    },
  }, {
    getRoom() {
      return null;
    },
    setRoom() {
      throw new Error('Disk full');
    },
  });

  const res = await invoke('POST', '/api/devices/:id/room', {
    headers: makeSessionHeaders(apiAuth),
    params: { id: 'light-1' },
    body: { room: 'Office' },
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Room memory error', message: 'Disk full' });
});

test('POST /api/rooms/learn returns 502 for upstream lookup failures', async () => {
  const upstreamHarness = makeRouteHarness();
  const apiAuth = makeApiAuth();
  setupRoutes(upstreamHarness.app, apiAuth, {
    async getAccessories() {
      throw new Error('Config UI unavailable');
    },
  }, {
    getRoom() {
      return null;
    },
    applyAssignments() {
      throw new Error('Should not write when upstream failed.');
    },
  });

  const upstreamRes = await upstreamHarness.invoke('POST', '/api/rooms/learn', {
    headers: makeSessionHeaders(apiAuth),
    body: { devices: [{ id: 'light-1', room: 'Office' }] },
  });

  assert.equal(upstreamRes.statusCode, 502);
  assert.deepEqual(upstreamRes.body, { error: 'Upstream error', message: 'Config UI unavailable' });
});

test('POST /api/rooms/learn preserves per-item validation and write errors', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth();
  setupRoutes(app, apiAuth, {
    async getAccessories() {
      return [
        { uniqueId: 'light-1', serviceName: 'Desk Lamp', humanType: 'Lightbulb' },
        { uniqueId: 'switch-1', serviceName: 'Outlet', humanType: 'Switch' },
      ];
    },
  }, {
    getRoom() {
      return null;
    },
    setRoom(id, room) {
      if (id === 'switch-1') throw new Error('Disk full');
      return { room };
    },
  });

  const res = await invoke('POST', '/api/rooms/learn', {
    headers: makeSessionHeaders(apiAuth),
    body: {
      devices: [
        { id: 'light-1', room: '  Office  ' },
        { id: '', room: 'Kitchen' },
        { id: 'missing-room', room: '' },
        { id: 'missing-device', room: 'Office' },
        { id: 'switch-1', room: 'Kitchen' },
      ],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    results: [
      { id: 'light-1', success: true, room: 'Office' },
      { id: '', success: false, error: 'Missing device id.' },
      { id: 'missing-room', success: false, error: 'Missing room.' },
      { id: 'missing-device', success: false, error: "Device 'missing-device' not found." },
      { id: 'switch-1', success: false, error: 'Disk full' },
    ],
  });
});

test('POST /api/auth/session exchanges the bootstrap token for a session token', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth('bootstrap-secret');
  setupRoutes(app, apiAuth, { async getAccessories() { return []; } }, { listRooms() { return []; } }, { since() { return []; } }, { externalUrl: 'http://localhost:8865', bootstrapToken: 'bootstrap-secret' });

  const res = await invoke('POST', '/api/auth/session', {
    headers: { authorization: 'Bearer bootstrap-secret' },
    body: { client_name: 'openclaw-test' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(typeof res.body.access_token, 'string');
  assert.equal(res.body.expires_in, 300);
});

test('session-protected routes reject the bootstrap token directly', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth('bootstrap-secret');
  setupRoutes(app, apiAuth, { async getAccessories() { return []; } }, { listRooms() { return []; } }, { since() { return []; } });

  const res = await invoke('GET', '/api/devices', {
    headers: { authorization: 'Bearer bootstrap-secret' },
    body: {},
  });

  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /session token/i);
});

test('GET /api/setup documents device-specific trigger matching when device_name is present', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth('bootstrap-secret');
  setupRoutes(
    app,
    apiAuth,
    { async getAccessories() { return []; } },
    { listRooms() { return []; } },
    { since() { return []; } },
    { externalUrl: 'http://localhost:8865', bootstrapToken: 'bootstrap-secret' },
  );

  const res = await invoke('GET', '/api/setup', {
    headers: { authorization: 'Bearer bootstrap-secret' },
    body: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skills[0].path, '.openclaw_gateway/commands/homekit-events.md');
  assert.equal(res.body.triggers[0].path, '.openclaw_gateway/homekit-triggers/garage-door-open.md');
  assert.match(
    res.body.skills[0].content,
    /If the trigger's `match` block also includes `device_name`, require it to equal the event's device name before treating it as a match/,
  );
  assert.match(
    res.body.claude_md_addition,
    /Use `match\.device_name` when a trigger should only fire for one specific HomeKit device\./,
  );
  assert.deepEqual(res.body.eventing, undefined);
});

test('health and setup surface event-source status when provided', async () => {
  const { app, invoke } = makeRouteHarness();
  const apiAuth = makeApiAuth('bootstrap-secret');
  const eventing = {
    mode: 'hybrid',
    queued_events: 4,
    sources: {
      poll: { state: 'running', detail: 'Polling Config UI X every 120s.' },
      hap: { state: 'unsupported', detail: 'UiClient does not expose HAP characteristic subscriptions yet.' },
    },
  };

  setupRoutes(
    app,
    apiAuth,
    {
      async getAccessories() {
        return [{ uniqueId: 'light-1', serviceName: 'Desk Lamp', humanType: 'Lightbulb' }];
      },
    },
    {
      listRooms() {
        return [];
      },
      getRoom() {
        return null;
      },
    },
    {
      count() {
        return 4;
      },
      since() {
        return [];
      },
    },
    {
      externalUrl: 'http://localhost:8865',
      bootstrapToken: 'bootstrap-secret',
      getEventingStatus: () => eventing,
    },
  );

  const healthRes = await invoke('GET', '/health', { headers: {}, body: {} });
  assert.equal(healthRes.statusCode, 200);
  assert.equal(healthRes.body.eventing.mode, 'hybrid');
  assert.equal(healthRes.body.eventing.queued_events, 4);
  assert.equal(healthRes.body.eventing.sources.hap.state, 'unsupported');

  const setupRes = await invoke('GET', '/api/setup', {
    headers: { authorization: 'Bearer bootstrap-secret' },
    body: {},
  });
  assert.equal(setupRes.statusCode, 200);
  assert.equal(setupRes.body.eventing.mode, 'hybrid');
});
