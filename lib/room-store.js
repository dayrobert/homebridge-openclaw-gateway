'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { resolve } = require('path');
const { PLUGIN_NAME, ROOMS_FILE_NAME } = require('./constants');

function normalizeRoomName(room) {
  return String(room || '').trim().replace(/\s+/g, ' ');
}

function normalizeRoomKey(room) {
  return normalizeRoomName(room).toLowerCase();
}

class RoomStore {
  constructor(storagePath, log) {
    this.filePath = resolve(storagePath, ROOMS_FILE_NAME);
    this.log = log;
    this.data = { version: 1, devices: {} };
    this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const rawDevices = parsed?.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
      const devices = {};
      for (const [id, entry] of Object.entries(rawDevices)) {
        const room = normalizeRoomName(entry?.room);
        if (!room) continue;
        devices[id] = {
          room,
          roomKey: normalizeRoomKey(room),
          updatedAt: entry?.updatedAt || null,
        };
      }
      this.data = { version: 1, devices };
    } catch (err) {
      this.log.warn(`[${PLUGIN_NAME}] Could not read room memory: ${err.message}`);
    }
  }

  _save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
  }

  getRoom(deviceId) {
    return this.data.devices[deviceId]?.room || null;
  }

  setRoom(deviceId, room) {
    const cleanRoom = normalizeRoomName(room);
    const roomKey = normalizeRoomKey(room);
    if (!deviceId) throw new Error('Missing device id.');
    if (!cleanRoom) throw new Error('Missing room.');
    this.data.devices[deviceId] = { room: cleanRoom, roomKey, updatedAt: new Date().toISOString() };
    this._save();
    return this.data.devices[deviceId];
  }

  clearRoom(deviceId) {
    if (!deviceId) throw new Error('Missing device id.');
    delete this.data.devices[deviceId];
    this._save();
  }

  applyAssignments(assignments) {
    const results = [];
    for (const item of assignments) {
      try {
        const entry = this.setRoom(item.id, item.room);
        results.push({ id: item.id, success: true, room: entry.room });
      } catch (err) {
        results.push({ id: item?.id, success: false, error: err.message });
      }
    }
    return results;
  }

  listRooms(devices = []) {
    const byId = new Map(devices.map(device => [device.id, device]));
    const rooms = new Map();
    for (const [id, entry] of Object.entries(this.data.devices)) {
      const room = entry?.room;
      const roomKey = entry?.roomKey || normalizeRoomKey(room);
      if (!roomKey) continue;
      if (!rooms.has(roomKey)) rooms.set(roomKey, { name: room, devices: [] });
      const bucket = rooms.get(roomKey);
      const device = byId.get(id);
      bucket.devices.push(device ? { id, name: device.name, type: device.type } : { id, stale: true });
    }
    return Array.from(rooms.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(room => ({
        name: room.name,
        count: room.devices.length,
        devices: room.devices.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
      }));
  }
}

module.exports = { RoomStore, normalizeRoomName, normalizeRoomKey, ROOMS_FILE_NAME };
