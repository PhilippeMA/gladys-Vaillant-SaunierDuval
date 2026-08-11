// -----------------------------------------------------------------------------
// How long a temporary override lasts.
//
// The Saunier Duval application asks for that duration every time: 30 minutes
// to 24 hours, in 30-minute steps. It is a control of its own on each zone,
// because a Gladys thermostat carries a temperature and nothing else.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  buildDeviceModels,
  findCommand,
  seedOverrideDurationsFromDevices,
} from '../src/devices/index.js';
import {
  MAX_OVERRIDE_MINUTES,
  MIN_OVERRIDE_MINUTES,
  getOverrideMinutes,
  normalizeOverrideMinutes,
  resetOverrideDurations,
} from '../src/devices/overrideDuration.js';
import { SaunierDuvalClient } from '../src/saunierDuval/client.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { tliSnapshotEntry } from './helpers/fixtures.js';

const ZONE = 'zone:system-1-0';
const DURATION_FEATURE = `${ZONE}:override-duration`;
const TEMPERATURE_FEATURE = `${ZONE}:target-temperature`;

const config = normalizeConfig({
  email: 'user@example.com',
  password: 's3cret',
  quick_veto_duration: 3,
});

beforeEach(() => resetOverrideDurations());

function recordingClient() {
  const client = new SaunierDuvalClient({
    email: 'user@example.com',
    password: 's3cret',
    country: 'france',
  });
  const calls = [];
  client.request = async (method, url, body) => {
    calls.push({ method, url, body });
    return null;
  };
  return { client, calls };
}

function models(entry = tliSnapshotEntry()) {
  return buildDeviceModels(createFakeGladys(), [entry], config);
}

test('the range and the granularity are the ones of the application', () => {
  assert.equal(MIN_OVERRIDE_MINUTES, 30);
  assert.equal(MAX_OVERRIDE_MINUTES, 24 * 60);

  // Anything the slider lands on comes back to a half-hour.
  assert.equal(normalizeOverrideMinutes(100), 90);
  assert.equal(normalizeOverrideMinutes(104), 90);
  assert.equal(normalizeOverrideMinutes(106), 120);
  assert.equal(normalizeOverrideMinutes(90), 90);
});

test('a duration outside the range is brought back into it', () => {
  assert.equal(normalizeOverrideMinutes(0), MIN_OVERRIDE_MINUTES);
  assert.equal(normalizeOverrideMinutes(5), MIN_OVERRIDE_MINUTES);
  assert.equal(normalizeOverrideMinutes(99999), MAX_OVERRIDE_MINUTES);
  assert.equal(normalizeOverrideMinutes('nonsense'), null);
});

test('a zone starts on the duration configured as the default', () => {
  const built = models();
  const duration = built
    .flatMap((model) => model.states)
    .find((state) => state.device_feature_external_id === DURATION_FEATURE);
  // 3 h of configuration -> 180 minutes on the control.
  assert.equal(duration.state, 180);
});

test('the control is published with the bounds and the unit of the application', () => {
  const zone = models().find((model) => model.externalId === ZONE);
  const feature = zone.device.features.find((f) => f.external_id === DURATION_FEATURE);

  assert.equal(feature.min, 30);
  assert.equal(feature.max, 1440);
  assert.equal(feature.unit, 'minutes');
  assert.equal(feature.read_only, false);
});

test('setting the duration sends nothing to the boiler', async () => {
  // The platform has no register for it: it only takes the duration alongside
  // the temperature, when the override actually starts.
  const { client, calls } = recordingClient();
  await findCommand(models(), DURATION_FEATURE)(client, 90);

  assert.equal(calls.length, 0);
  assert.equal(getOverrideMinutes(ZONE, config), 90);
});

test('the duration chosen is the one the next override uses', async () => {
  const { client, calls } = recordingClient();

  await findCommand(models(), DURATION_FEATURE)(client, 30);
  // The fixture zone is scheduled, so a temperature starts an override.
  await findCommand(models(), TEMPERATURE_FEATURE)(client, 21);

  assert.equal(calls.length, 1);
  // The platform takes hours: 30 minutes -> 0.5.
  assert.deepEqual(calls[0].body, { desiredRoomTemperatureSetpoint: 21, duration: 0.5 });
});

test('a duration off the step is applied on the half-hour', async () => {
  const { client, calls } = recordingClient();

  await findCommand(models(), DURATION_FEATURE)(client, 100);
  await findCommand(models(), TEMPERATURE_FEATURE)(client, 20);

  assert.equal(calls[0].body.duration, 1.5);
});

test('the maximum of the application is honoured end to end', async () => {
  const { client, calls } = recordingClient();

  await findCommand(models(), DURATION_FEATURE)(client, 1440);
  await findCommand(models(), TEMPERATURE_FEATURE)(client, 20);

  assert.equal(calls[0].body.duration, 24);
});

test('each zone keeps its own duration', async () => {
  const entry = tliSnapshotEntry();
  entry.system.properties.zones.push({ index: 1, isActive: true, associatedCircuitIndex: 0 });
  entry.system.state.zones.push({
    index: 1,
    currentRoomTemperature: 18,
    currentSpecialFunction: 'NONE',
  });
  entry.system.configuration.zones.push({
    index: 1,
    general: { name: 'Chambre' },
    heating: { operationModeHeating: 'TIME_CONTROLLED', manualModeSetpointHeating: 19 },
  });

  const { client } = recordingClient();
  await findCommand(models(entry), DURATION_FEATURE)(client, 60);

  assert.equal(getOverrideMinutes(ZONE, config), 60);
  // Untouched zone: still on the configured default.
  assert.equal(getOverrideMinutes('zone:system-1-1', config), 180);
});

test('a restart restores the duration Gladys kept, not the default', () => {
  // The choice lives in this process; Gladys stores the last value of the
  // feature, so a restarted container reads it back instead of silently
  // reverting to the configured default.
  const restored = seedOverrideDurationsFromDevices([
    {
      external_id: ZONE,
      features: [{ external_id: DURATION_FEATURE, last_value: 90 }],
    },
  ]);

  assert.equal(restored, 1);
  assert.equal(getOverrideMinutes(ZONE, config), 90);
});

test('a restored value never overwrites a choice already made', async () => {
  const { client } = recordingClient();
  await findCommand(models(), DURATION_FEATURE)(client, 60);

  seedOverrideDurationsFromDevices([
    { external_id: ZONE, features: [{ external_id: DURATION_FEATURE, last_value: 720 }] },
  ]);

  assert.equal(getOverrideMinutes(ZONE, config), 60);
});

test('the configured default is itself snapped to a half-hour', () => {
  // A number field cannot declare a step in the manifest, so 1.7 h can be
  // typed; the boiler works in half-hours.
  assert.equal(normalizeConfig({ quick_veto_duration: 1.7 }).quick_veto_duration, 1.5);
  assert.equal(normalizeConfig({ quick_veto_duration: 0.1 }).quick_veto_duration, 0.5);
  assert.equal(normalizeConfig({ quick_veto_duration: 48 }).quick_veto_duration, 24);
});
