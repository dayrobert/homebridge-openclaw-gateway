'use strict';

class EventQueue {
  constructor(maxSize = 200) {
    this.events = [];
    this.maxSize = maxSize;
  }

  push(event) {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > this.maxSize) this.events.shift();
  }

  count() {
    return this.events.length;
  }

  since(timestamp, priority = null) {
    const ts = Number(timestamp) || 0;
    return this.events.filter(e =>
      e.timestamp > ts && (priority === null || e.priority === priority)
    );
  }
}

function classifyPriority(device, changes) {
  if (device.type === 'lock' || device.type === 'garage') return 'high';
  if ('MotionDetected' in changes || 'ContactSensorState' in changes) return 'high';
  if (device.type === 'thermostat' || device.type === 'sensor') return 'medium';
  return 'low';
}

function diffSnapshot(prevMap, nextDevices) {
  const results = [];
  for (const device of nextDevices) {
    const prev = prevMap.get(device.id);
    if (!prev) continue;
    const changes = {};
    for (const [k, v] of Object.entries(device.state)) {
      if (prev.state[k] !== v) changes[k] = { from: prev.state[k], to: v };
    }
    if (Object.keys(changes).length > 0) results.push({ device, changes });
  }
  return results;
}

function formatEventDescription(event) {
  const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).toLowerCase();
  if (event.type === 'garage' && 'CurrentDoorState' in event.changes) {
    return `${event.name} ${event.changes.CurrentDoorState.to === 0 ? 'opened' : 'closed'} (${time})`;
  }
  if (event.type === 'lock' && 'LockCurrentState' in event.changes) {
    return `${event.name} ${event.changes.LockCurrentState.to === 1 ? 'locked' : 'unlocked'} (${time})`;
  }
  if ('MotionDetected' in event.changes) {
    return `Motion detected: ${event.name} (${time})`;
  }
  if ('ContactSensorState' in event.changes) {
    return `${event.name} ${event.changes.ContactSensorState.to === 1 ? 'opened' : 'closed'} (${time})`;
  }
  if ('On' in event.changes) {
    return `${event.name} turned ${event.changes.On.to ? 'on' : 'off'} (${time})`;
  }
  const entries = Object.entries(event.changes);
  const charName = entries[0]?.[0];
  const charChange = entries[0]?.[1];
  return `${event.name} ${charName || 'state'} → ${charChange?.to ?? '?'} (${time})`;
}

module.exports = { EventQueue, classifyPriority, diffSnapshot, formatEventDescription };
