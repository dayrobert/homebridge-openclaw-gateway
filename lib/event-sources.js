'use strict';

const {
  DEFAULT_EVENT_SOURCE,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_HAP_FALLBACK_POLL_INTERVAL,
} = require('./constants');
const { parseAccessories } = require('./devices');
const { classifyPriority, diffSnapshot } = require('./events');

const HAP_SUBSCRIBE_CHARACTERISTICS = {
  garage: ['CurrentDoorState'],
  lock: ['LockCurrentState'],
  motion: ['MotionDetected'],
  contact: ['ContactSensorState'],
  statelessswitch: ['ProgrammableSwitchEvent'],
};

function normalizeEventSource(value) {
  const source = String(value || DEFAULT_EVENT_SOURCE).trim().toLowerCase();
  return ['poll', 'hap', 'hybrid'].includes(source) ? source : DEFAULT_EVENT_SOURCE;
}

function normalizeSubscribeTypes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return ['garage', 'lock', 'motion', 'contact'];
  }
  return [...new Set(value.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function getHapCharacteristicTypes(subscribeTypes) {
  return [...new Set(subscribeTypes.flatMap(type => HAP_SUBSCRIBE_CHARACTERISTICS[type] || []))];
}

function createEventSink({ eventQueue, dedupeWindowMs = 2500 }) {
  let recentEvents = [];

  const cleanup = now => {
    recentEvents = recentEvents.filter(entry => now - entry.timestamp <= dedupeWindowMs);
  };

  return {
    emit(event) {
      const now = Date.now();
      cleanup(now);

      const signature = JSON.stringify({
        id: event.id,
        room: event.room || null,
        changes: event.changes,
      });

      const duplicate = recentEvents.find(entry =>
        entry.signature === signature && now - entry.timestamp <= dedupeWindowMs
      );
      if (duplicate) return false;

      recentEvents.push({ signature, timestamp: now });
      eventQueue.push(event);
      return true;
    },
  };
}

function createSourceStatus(name) {
  return {
    name,
    state: 'idle',
    detail: '',
    startedAt: null,
    lastEventAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    error: null,
  };
}

class PollingEventSource {
  constructor({ uiClient, roomStore, eventSink, log, intervalSeconds, status, name = 'poll' }) {
    this.uiClient = uiClient;
    this.roomStore = roomStore;
    this.eventSink = eventSink;
    this.log = log;
    this.intervalSeconds = Math.max(10, Math.min(300, Number(intervalSeconds) || DEFAULT_POLL_INTERVAL));
    this.status = status || createSourceStatus(name);
    this.name = name;
    this.timer = null;
    this.lastSnapshot = new Map();
  }

  async start() {
    this.status.state = 'starting';
    this.status.startedAt = new Date().toISOString();
    this.status.detail = `Polling Config UI X every ${this.intervalSeconds}s.`;

    const tick = async () => {
      try {
        const raw = await this.uiClient.getAccessories();
        const devices = parseAccessories(raw, this.roomStore);
        const diffs = diffSnapshot(this.lastSnapshot, devices);

        for (const { device, changes } of diffs) {
          const accepted = this.eventSink.emit({
            id: device.id,
            name: device.name,
            type: device.type,
            room: device.room,
            changes,
            priority: classifyPriority(device, changes),
            source: this.name,
          });
          if (accepted) this.status.lastEventAt = new Date().toISOString();
        }

        this.lastSnapshot = new Map(devices.map(device => [device.id, device]));
        this.status.state = 'running';
        this.status.lastSuccessAt = new Date().toISOString();
        this.status.error = null;
      } catch (err) {
        this.status.state = 'degraded';
        this.status.lastErrorAt = new Date().toISOString();
        this.status.error = err.message;
        this.log.debug(`[${this.name}] State poll error: ${err.message}`);
      }
    };

    await tick();
    this.timer = setInterval(tick, this.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.state = this.status.state === 'unsupported' ? 'unsupported' : 'stopped';
  }
}

class HapSubscriptionSource {
  constructor({ uiClient, eventSink, log, subscribeTypes, status }) {
    this.uiClient = uiClient;
    this.eventSink = eventSink;
    this.log = log;
    this.subscribeTypes = normalizeSubscribeTypes(subscribeTypes);
    this.status = status || createSourceStatus('hap');
    this.unsubscribe = null;
  }

  async start() {
    this.status.state = 'starting';
    this.status.startedAt = new Date().toISOString();
    this.status.detail = `Subscribing to HAP notifications for ${this.subscribeTypes.join(', ')}.`;

    if (typeof this.uiClient.subscribeCharacteristics !== 'function') {
      this.status.state = 'unsupported';
      this.status.detail = 'UiClient does not expose HAP characteristic subscriptions yet.';
      return;
    }

    try {
      const result = await this.uiClient.subscribeCharacteristics({
        subscribeTypes: this.subscribeTypes,
        characteristicTypes: getHapCharacteristicTypes(this.subscribeTypes),
        onEvent: event => {
          const accepted = this.eventSink.emit({
            ...event,
            source: event.source || 'hap',
          });
          if (accepted) this.status.lastEventAt = new Date().toISOString();
          this.status.lastSuccessAt = new Date().toISOString();
        },
      });

      if (!result || result.supported === false) {
        this.status.state = 'unsupported';
        this.status.detail = result?.reason || 'HAP subscriptions are unavailable in this environment.';
        return;
      }

      this.unsubscribe = typeof result.unsubscribe === 'function' ? result.unsubscribe : null;
      this.status.state = 'running';
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.detail = `Listening for HAP notifications on ${result.subscriptionCount || getHapCharacteristicTypes(this.subscribeTypes).length} characteristic types.`;
    } catch (err) {
      this.status.state = 'degraded';
      this.status.lastErrorAt = new Date().toISOString();
      this.status.error = err.message;
      this.status.detail = 'HAP subscription startup failed.';
      this.log.warn(`[hap] Subscription startup failed: ${err.message}`);
    }
  }

  stop() {
    if (typeof this.unsubscribe === 'function') this.unsubscribe();
    this.unsubscribe = null;
    this.status.state = this.status.state === 'unsupported' ? 'unsupported' : 'stopped';
  }
}

async function startEventSources({
  config = {},
  uiClient,
  roomStore,
  eventQueue,
  log,
}) {
  const mode = normalizeEventSource(config.eventSource);
  const sink = createEventSink({ eventQueue });
  const statuses = {
    poll: createSourceStatus('poll'),
    hap: createSourceStatus('hap'),
  };
  const activeSources = [];

  if (mode === 'poll' || mode === 'hybrid') {
    activeSources.push(new PollingEventSource({
      uiClient,
      roomStore,
      eventSink: sink,
      log,
      intervalSeconds: mode === 'hybrid'
        ? (config.hapFallbackPollInterval || DEFAULT_HAP_FALLBACK_POLL_INTERVAL)
        : (config.pollInterval || DEFAULT_POLL_INTERVAL),
      status: statuses.poll,
      name: mode === 'hybrid' ? 'poll-fallback' : 'poll',
    }));
  }

  if (mode === 'hap' || mode === 'hybrid') {
    activeSources.push(new HapSubscriptionSource({
      uiClient,
      eventSink: sink,
      log,
      subscribeTypes: config.hapSubscribeTypes,
      status: statuses.hap,
    }));
  } else {
    statuses.hap.state = 'disabled';
    statuses.hap.detail = 'HAP subscriptions are disabled in poll mode.';
  }

  if (mode === 'hap') {
    statuses.poll.state = 'disabled';
    statuses.poll.detail = 'Polling is disabled in hap mode.';
  }

  for (const source of activeSources) await source.start();

  return {
    mode,
    statuses,
    stop() {
      for (const source of activeSources) source.stop();
    },
    summary() {
      return {
        mode,
        queued_events: eventQueue.count(),
        sources: statuses,
      };
    },
  };
}

module.exports = {
  PollingEventSource,
  HapSubscriptionSource,
  createEventSink,
  createSourceStatus,
  normalizeEventSource,
  normalizeSubscribeTypes,
  getHapCharacteristicTypes,
  startEventSources,
};
