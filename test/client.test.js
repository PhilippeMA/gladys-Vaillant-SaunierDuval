// -----------------------------------------------------------------------------
// The API client: how a raw payload becomes a usable snapshot, and how a user
// command becomes the right HTTP call.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSetpoint,
  MAX_SETPOINT,
  MIN_SETPOINT,
  normalizeSystem,
  resolveOnMode,
  resolveTargetTemperature,
} from '../src/api/client.js';
import { buildRawSystem, HOME, SYSTEM_ID } from './helpers/fixtures.js';
import { buildStubbedClient, writeCalls } from './helpers/stubClient.js';

// --- Normalization -----------------------------------------------------------

test('normalizeSystem flattens the state, properties and configuration blocks', () => {
  const system = normalizeSystem({
    home: HOME,
    raw: buildRawSystem(),
    controlIdentifier: 'tli',
  });

  assert.equal(system.id, SYSTEM_ID);
  assert.equal(system.name, 'Maison');
  assert.equal(system.productType, 'MiGo Link');
  assert.equal(system.outdoorTemperature, 4.0585938);
  assert.equal(system.waterPressure, 1.3);
  assert.equal(system.heatingActive, false);

  assert.equal(system.zones.length, 1);
  const [zone] = system.zones;
  assert.equal(zone.index, 0);
  assert.equal(zone.name, 'Salon');
  assert.equal(zone.isActive, true);
  assert.equal(zone.currentTemperature, 21.9125);
  assert.equal(zone.humidity, 42);
  assert.equal(zone.targetTemperature, 20);
  assert.equal(zone.operationMode, 'TIME_CONTROLLED');
  assert.equal(zone.heatingEnabled, true);
});

test('normalizeSystem reports the boiler as active when a circuit is heating', () => {
  const system = normalizeSystem({
    home: HOME,
    raw: buildRawSystem({ circuitState: { circuitState: 'HEATING' } }),
    controlIdentifier: 'tli',
  });
  assert.equal(system.heatingActive, true);
  assert.deepEqual(system.circuitStates, ['HEATING']);
});

test('normalizeSystem reports heating as off when the zone mode is OFF', () => {
  const system = normalizeSystem({
    home: HOME,
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'OFF' } }),
    controlIdentifier: 'tli',
  });
  assert.equal(system.zones[0].heatingEnabled, false);
});

test('normalizeSystem maps missing sensors to null rather than to zero', () => {
  const raw = buildRawSystem();
  delete raw.state.zones[0].currentRoomHumidity;
  delete raw.state.system.systemWaterPressure;

  const system = normalizeSystem({ home: HOME, raw, controlIdentifier: 'tli' });
  assert.equal(system.zones[0].humidity, null);
  assert.equal(system.waterPressure, null);
});

test('normalizeSystem names a zone after its index when the controller gives none', () => {
  const raw = buildRawSystem();
  raw.configuration.zones[0].general = {};

  const system = normalizeSystem({ home: HOME, raw, controlIdentifier: 'tli' });
  assert.equal(system.zones[0].name, 'Zone 1');
});

test('normalizeSystem reads the VRC700 comfort setpoint as the zone setpoint', () => {
  const raw = buildRawSystem({
    zoneHeating: {
      operationModeHeating: 'AUTO',
      manualModeSetpointHeating: undefined,
      dayTemperatureHeating: 21.5,
    },
    zoneState: { desiredRoomTemperatureSetpoint: 0 },
  });

  const system = normalizeSystem({ home: HOME, raw, controlIdentifier: 'vrc700' });
  assert.equal(system.zones[0].comfortSetpoint, 21.5);
});

// --- Setpoint resolution -----------------------------------------------------

test('resolveTargetTemperature prefers the effective desired setpoint', () => {
  const target = resolveTargetTemperature({
    desired: 20,
    desiredHeating: 19,
    comfortSetpoint: 21,
    setBackTemperature: 18,
  });
  assert.equal(target, 20);
});

test('resolveTargetTemperature ignores the 0 the API reports for "no heat wanted"', () => {
  const target = resolveTargetTemperature({
    desired: 0,
    desiredHeating: 0,
    comfortSetpoint: 19,
    setBackTemperature: 18,
  });
  assert.equal(target, 19);
});

test('resolveTargetTemperature falls back to the setback temperature', () => {
  const target = resolveTargetTemperature({
    desired: 0,
    desiredHeating: null,
    comfortSetpoint: null,
    setBackTemperature: 16,
  });
  assert.equal(target, 16);
});

test('resolveTargetTemperature returns null when nothing is known', () => {
  const target = resolveTargetTemperature({
    desired: null,
    desiredHeating: null,
    comfortSetpoint: null,
    setBackTemperature: null,
  });
  assert.equal(target, null);
});

test('clampSetpoint keeps a setpoint inside the controller range', () => {
  assert.equal(clampSetpoint(45), MAX_SETPOINT);
  assert.equal(clampSetpoint(-5), MIN_SETPOINT);
  assert.equal(clampSetpoint(20.3), 20.5);
  assert.equal(clampSetpoint(20.1), 20);
});

test('resolveOnMode speaks the vocabulary of each controller family', () => {
  assert.equal(resolveOnMode('TIME_CONTROLLED', false), 'TIME_CONTROLLED');
  assert.equal(resolveOnMode('MANUAL', false), 'MANUAL');
  assert.equal(resolveOnMode('TIME_CONTROLLED', true), 'AUTO');
  assert.equal(resolveOnMode('MANUAL', true), 'DAY');
});

// --- Caching -----------------------------------------------------------------

test('getSystems serves the cache instead of calling the API again', async () => {
  const { client, calls } = buildStubbedClient();

  await client.getSystems();
  const callsAfterFirst = calls.length;
  await client.getSystems();
  assert.equal(calls.length, callsAfterFirst, 'the second read must not hit the API');

  await client.getSystems({ force: true });
  assert.ok(calls.length > callsAfterFirst, 'a forced read must hit the API');
});

test('concurrent reads share a single API round trip', async () => {
  const { client, calls } = buildStubbedClient();

  await Promise.all([client.getSystems(), client.getSystems(), client.getSystems()]);

  const homeCalls = calls.filter((call) => call.url.endsWith('/homes'));
  assert.equal(homeCalls.length, 1);
});

// --- Commands: target temperature --------------------------------------------

test('a zone on its schedule gets a temporary override', async () => {
  const { client, calls } = buildStubbedClient();

  const applied = await client.setTargetTemperature({
    systemId: SYSTEM_ID,
    zoneIndex: 0,
    temperature: 21,
    durationHours: 2,
  });

  assert.equal(applied, 21);
  const [write] = writeCalls(calls);
  assert.equal(write.method, 'POST');
  assert.match(write.url, /\/systems\/.+\/tli\/zones\/0\/quick-veto$/);
  assert.deepEqual(write.body, { desiredRoomTemperatureSetpoint: 21, duration: 2 });
});

test('an override already running is updated in place instead of recreated', async () => {
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneState: { currentSpecialFunction: 'QUICK_VETO' } }),
  });

  await client.setTargetTemperature({ systemId: SYSTEM_ID, zoneIndex: 0, temperature: 22 });

  const [write] = writeCalls(calls);
  assert.equal(write.method, 'PATCH');
  assert.match(write.url, /\/quick-veto$/);
  assert.deepEqual(write.body, { desiredRoomTemperatureSetpoint: 22 });
});

test('a zone in manual mode gets its permanent setpoint changed', async () => {
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'MANUAL' } }),
  });

  await client.setTargetTemperature({ systemId: SYSTEM_ID, zoneIndex: 0, temperature: 19.5 });

  const [write] = writeCalls(calls);
  assert.equal(write.method, 'PATCH');
  assert.match(write.url, /\/zones\/0\/manual-mode-setpoint$/);
  assert.deepEqual(write.body, { setpoint: 19.5, type: 'HEATING' });
});

test('a zone switched off is turned back on at the requested temperature', async () => {
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'OFF' } }),
  });

  await client.setTargetTemperature({ systemId: SYSTEM_ID, zoneIndex: 0, temperature: 20 });

  const writes = writeCalls(calls);
  assert.equal(writes.length, 2);
  assert.match(writes[0].url, /\/zones\/0\/heating-operation-mode$/);
  assert.deepEqual(writes[0].body, { operationMode: 'MANUAL' });
  assert.match(writes[1].url, /\/zones\/0\/manual-mode-setpoint$/);
  assert.deepEqual(writes[1].body, { setpoint: 20, type: 'HEATING' });
});

test('a VRC700 zone in DAY mode uses its comfort room temperature route', async () => {
  const { client, calls } = buildStubbedClient({
    controlIdentifier: 'vrc700',
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'DAY' } }),
  });

  await client.setTargetTemperature({ systemId: SYSTEM_ID, zoneIndex: 0, temperature: 21 });

  const [write] = writeCalls(calls);
  assert.equal(write.method, 'PATCH');
  assert.match(write.url, /vrc700\/v1\/systems\/.+\/zone\/0\/heating\/comfort-room-temperature$/);
  assert.deepEqual(write.body, { comfortRoomTemperature: 21 });
});

test('a temperature outside the controller range is clamped before being sent', async () => {
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'MANUAL' } }),
  });

  const applied = await client.setTargetTemperature({
    systemId: SYSTEM_ID,
    zoneIndex: 0,
    temperature: 99,
  });

  assert.equal(applied, MAX_SETPOINT);
  assert.deepEqual(writeCalls(calls)[0].body, { setpoint: MAX_SETPOINT, type: 'HEATING' });
});

// --- Commands: heating on/off ------------------------------------------------

test('turning heating off switches the zone to OFF', async () => {
  const { client, calls } = buildStubbedClient();

  const mode = await client.setHeatingEnabled({
    systemId: SYSTEM_ID,
    zoneIndex: 0,
    enabled: false,
  });

  assert.equal(mode, 'OFF');
  const [write] = writeCalls(calls);
  assert.equal(write.method, 'PATCH');
  assert.match(write.url, /\/zones\/0\/heating-operation-mode$/);
  assert.deepEqual(write.body, { operationMode: 'OFF' });
});

test('turning heating on restores the configured mode', async () => {
  const { client, calls } = buildStubbedClient({
    raw: buildRawSystem({ zoneHeating: { operationModeHeating: 'OFF' } }),
  });

  const mode = await client.setHeatingEnabled({
    systemId: SYSTEM_ID,
    zoneIndex: 0,
    enabled: true,
    onMode: 'MANUAL',
  });

  assert.equal(mode, 'MANUAL');
  assert.deepEqual(writeCalls(calls)[0].body, { operationMode: 'MANUAL' });
});

test('a VRC700 zone changes its mode on the system-control API', async () => {
  const { client, calls } = buildStubbedClient({ controlIdentifier: 'vrc700' });

  await client.setHeatingEnabled({ systemId: SYSTEM_ID, zoneIndex: 0, enabled: false });

  const [write] = writeCalls(calls);
  assert.match(write.url, /system-control\/v1\/systems\/.+\/zones\/0\/heating-operation-mode$/);
});

test('a command invalidates the snapshot so the next read is fresh', async () => {
  const { client, calls } = buildStubbedClient();
  await client.getSystems();

  await client.setHeatingEnabled({ systemId: SYSTEM_ID, zoneIndex: 0, enabled: false });
  const before = calls.length;
  await client.getSystems();

  assert.ok(calls.length > before, 'the snapshot must have been refetched');
});

test('commanding an unknown zone fails instead of writing anywhere', async () => {
  const { client, calls } = buildStubbedClient();

  await assert.rejects(
    () => client.setTargetTemperature({ systemId: SYSTEM_ID, zoneIndex: 7, temperature: 20 }),
    /Zone 7/,
  );
  assert.equal(writeCalls(calls).length, 0);
});
