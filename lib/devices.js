'use strict';

function parseAccessories(raw, roomStore = null) {
  const list = Array.isArray(raw) ? raw : [];
  const devices = [];
  for (const svc of list) {
    const name = svc.serviceName || svc.accessoryInformation?.Name || '';
    const type = svc.humanType || svc.type || 'Unknown';
    const uid = svc.uniqueId;
    if (!uid || type === 'AccessoryInformation' || type === 'ProtocolInformation') continue;
    if (name.toLowerCase() === 'openclaw api') continue;
    const writableChars = (svc.serviceCharacteristics || []).filter(c => c.canWrite).map(c => c.type);
    devices.push({
      id: uid,
      name,
      type: mapType(type),
      humanType: type,
      room: roomStore?.getRoom(uid) || null,
      state: svc.values || {},
      characteristics: writableChars,
      manufacturer: svc.accessoryInformation?.Manufacturer || '',
      model: svc.accessoryInformation?.Model || '',
    });
  }
  return devices;
}

function mapType(humanType) {
  const t = (humanType || '').toLowerCase();
  if (t.includes('light') || t.includes('bulb')) return 'lightbulb';
  if (t.includes('switch')) return 'switch';
  if (t.includes('outlet')) return 'outlet';
  if (t.includes('thermostat')) return 'thermostat';
  if (t.includes('lock')) return 'lock';
  if (t.includes('fan')) return 'fan';
  if (t.includes('window') || t.includes('blind') || t.includes('covering')) return 'blinds';
  if (t.includes('garage')) return 'garage';
  if (t.includes('motion')) return 'motion';
  if (t.includes('temperature')) return 'sensor';
  if (t.includes('humidity')) return 'sensor';
  if (t.includes('contact')) return 'sensor';
  if (t.includes('camera')) return 'camera';
  return 'other';
}

const MODE_MAP = { off: 0, heat: 1, cool: 2, auto: 3 };

function resolveAction(action, value) {
  switch (action) {
    case 'on': case 'power':
      return { characteristicType: 'On', value: Boolean(value) };
    case 'toggle':
      return { characteristicType: 'On', value: Boolean(value) };
    case 'brightness': case 'dim':
      return { characteristicType: 'Brightness', value: clamp(value, 0, 100) };
    case 'hue':
      return { characteristicType: 'Hue', value: clamp(value, 0, 360) };
    case 'saturation':
      return { characteristicType: 'Saturation', value: clamp(value, 0, 100) };
    case 'color': {
      const ops = [];
      if (value?.hue !== undefined) ops.push({ characteristicType: 'Hue', value: Number(value.hue) });
      if (value?.saturation !== undefined) ops.push({ characteristicType: 'Saturation', value: Number(value.saturation) });
      return ops;
    }
    case 'colorTemperature': case 'ct':
      return { characteristicType: 'ColorTemperature', value: Number(value) };
    case 'targetTemperature': case 'temperature':
      return { characteristicType: 'TargetTemperature', value: Number(value) };
    case 'thermostatMode': case 'mode':
      return { characteristicType: 'TargetHeatingCoolingState', value: MODE_MAP[String(value).toLowerCase()] ?? Number(value) };
    case 'lock':
      return { characteristicType: 'LockTargetState', value: value ? 1 : 0 };
    case 'speed': case 'rotationSpeed':
      return { characteristicType: 'RotationSpeed', value: clamp(value, 0, 100) };
    case 'position': case 'targetPosition':
      return { characteristicType: 'TargetPosition', value: clamp(value, 0, 100) };
    case 'tilt': case 'targetTilt':
      return { characteristicType: 'TargetHorizontalTiltAngle', value: clamp(value, -90, 90) };
    case 'garageDoor': case 'garage':
      return { characteristicType: 'TargetDoorState', value: value ? 0 : 1 };
    default:
      return null;
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v))); }

module.exports = { parseAccessories, mapType, resolveAction, clamp };
