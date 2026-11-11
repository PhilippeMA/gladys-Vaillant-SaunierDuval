// -----------------------------------------------------------------------------
// The dashboard widget.
//
// The core never trusts a widget content: what does not fit its vocabulary or
// its budget is dropped silently, and the card ships with a hole. The checks
// the core applies are exported by the SDK (`validateWidgetContent`): an empty
// list means "rendered exactly as sent".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import { buildDeviceModels } from '../src/devices/index.js';
import { buildBoilerContent } from '../src/widgets.js';
import { createFakeGladys, id } from './helpers/fakeGladys.js';
import { CREDENTIALS, startApp } from './helpers/app.js';
import { tliSnapshotEntry, vrc700SnapshotEntry } from './helpers/fixtures.js';

const config = normalizeConfig(CREDENTIALS);

function contentOf(entries, settings = {}) {
  const models = buildDeviceModels(createFakeGladys(), entries, config);
  return buildBoilerContent(models, { settings, config });
}

const ofType = (content, type) => content.components.filter((c) => c.type === type);
const statusValue = (content, labelFr) =>
  ofType(content, 'status')[0].items.find(
    (item) => item.label === labelFr || item.label?.fr === labelFr,
  )?.value;
const button = (content, actionKey) =>
  ofType(content, 'button').find((b) => b.action.key === actionKey);

/** An installation with `count` zones, to stress the budget of a card. */
function entryWithZones(count) {
  const entry = tliSnapshotEntry();
  for (let index = 1; index < count; index += 1) {
    entry.system.properties.zones.push({ index, isActive: true, associatedCircuitIndex: 0 });
    entry.system.state.zones.push({
      index,
      currentRoomTemperature: 18 + index,
      currentSpecialFunction: 'NONE',
    });
    entry.system.configuration.zones.push({
      index,
      general: { name: `Zone number ${index} with a rather long name indeed` },
      heating: { operationModeHeating: 'MANUAL', manualModeSetpointHeating: 19 },
    });
  }
  return entry;
}

test('the card is rendered exactly as sent', () => {
  for (const entries of [[tliSnapshotEntry()], [vrc700SnapshotEntry()]]) {
    assert.deepEqual(validateWidgetContent(contentOf(entries)), []);
  }
});

test('the card still fits its budget with many zones and long names', () => {
  for (const zones of [2, 3, 6]) {
    const content = contentOf([entryWithZones(zones)]);
    assert.deepEqual(validateWidgetContent(content), [], `${zones} zones`);
    assert.ok(content.components.length <= 8);
  }
});

test('the card shows the temperatures that matter', () => {
  const tiles = ofType(contentOf([tliSnapshotEntry()]), 'value');

  assert.deepEqual(
    tiles.map((tile) => [tile.label.fr ?? tile.label, tile.value, tile.unit]),
    [
      ['Salon', 19.3, '°C'],
      ['Eau chaude', 43, '°C'],
      ['Pression', 1.3, 'bar'],
      ['Extérieur', 8, '°C'],
    ],
  );
});

test('a low water pressure is the colour of a warning', () => {
  const entry = tliSnapshotEntry();
  const pressureColor = () =>
    ofType(contentOf([entry]), 'value').find((tile) => tile.unit === 'bar').color;

  assert.equal(pressureColor(), 'success');
  entry.system.state.system.systemWaterPressure = 0.8;
  assert.equal(pressureColor(), 'warning');
  entry.system.state.system.systemWaterPressure = 0.4;
  assert.equal(pressureColor(), 'danger');
});

test('the modes read like in the Saunier Duval application', () => {
  // The thermostat control can only show the vocabulary of Gladys ("Heating",
  // "Auto"). The card is ours: manual, schedule, off.
  const entry = tliSnapshotEntry();
  const zoneRow = () => statusValue(contentOf([entry]), 'Salon');
  const heating = entry.system.configuration.zones[0].heating;

  assert.equal(zoneRow().fr, 'Programmation · 21 °C');
  heating.operationModeHeating = 'MANUAL';
  assert.equal(zoneRow().fr, 'Manuel · 21 °C');
  heating.operationModeHeating = 'OFF';
  assert.equal(zoneRow().fr, 'Arrêt');
});

test('an override in progress is said on the row of the zone', () => {
  const entry = tliSnapshotEntry();
  entry.system.state.zones[0].currentSpecialFunction = 'QUICK_VETO';
  entry.system.state.zones[0].desiredRoomTemperatureSetpoint = 23;

  assert.equal(statusValue(contentOf([entry]), 'Salon').fr, 'Programmation · 23 °C (forçage)');
});

test('faults and the gateway are on the card', () => {
  const healthy = contentOf([tliSnapshotEntry()]);
  assert.equal(statusValue(healthy, 'Défauts').fr, 'Aucun');
  assert.equal(statusValue(healthy, 'Passerelle').fr, 'En ligne');

  const faulty = vrc700SnapshotEntry();
  faulty.online = false;
  const content = contentOf([faulty]);
  assert.equal(statusValue(content, 'Défauts'), 'F.28 Ignition failure');
  assert.equal(statusValue(content, 'Passerelle').fr, 'Hors ligne');
});

test('each boost button offers the opposite of the current state', () => {
  const idle = contentOf([tliSnapshotEntry()]);
  assert.equal(button(idle, 'hot_water_boost').label.fr, 'Boost eau chaude');
  assert.deepEqual(button(idle, 'hot_water_boost').action.params, {
    feature: id('hot-water:system-1-255:boost'),
    value: 1,
  });
  assert.equal(button(idle, 'ventilation_boost').action.params.value, 1);

  const entry = tliSnapshotEntry();
  entry.system.state.dhw[0].currentSpecialFunction = 'CYLINDER_BOOST';
  entry.system.state.zones[0].currentSpecialFunction = 'VENTILATION_BOOST';
  const running = contentOf([entry]);
  assert.equal(button(running, 'hot_water_boost').action.params.value, 0);
  assert.equal(button(running, 'ventilation_boost').label.fr, 'Arrêter ventilation');
  assert.equal(button(running, 'ventilation_boost').action.params.value, 0);
});

test('with several boilers, the setting picks the installation shown', () => {
  const entries = [tliSnapshotEntry(), vrc700SnapshotEntry()];

  // Without a setting: the first one.
  assert.equal(ofType(contentOf(entries), 'value')[0].label, 'Salon');
  // Any device of the installation designates it.
  const second = contentOf(entries, { device: id('circuit:system-2-0') });
  assert.equal(ofType(second, 'value')[0].label, 'Séjour');
});

test('displaying the card never costs a call to the platform', async () => {
  const t = await startApp();
  const callsBefore = t.calls.length;

  for (let i = 0; i < 5; i += 1) {
    const ack = await t.gladys.fake.widgetGet('boiler', { settings: {} });
    assert.equal(ack.success, true);
    assert.deepEqual(validateWidgetContent(ack.data.content), []);
  }

  // Five dashboards open, or one refreshed five times: same reading.
  assert.equal(t.calls.length, callsBefore);

  await t.stop();
});

test('every reading of the boiler nudges the card', async () => {
  const t = await startApp();
  const nudgesBefore = t.gladys.fake.widgetRefreshes.length;

  await t.readAgain();

  assert.ok(t.gladys.fake.widgetRefreshes.length > nudgesBefore);
  assert.ok(t.gladys.fake.widgetRefreshes.every((key) => key === 'boiler'));

  await t.stop();
});

test('the boost buttons run the same command as the device control', async () => {
  const t = await startApp();
  const content = (await t.gladys.fake.widgetGet('boiler', { settings: {} })).data.content;

  const { key, params } = button(content, 'hot_water_boost').action;
  const ack = await t.gladys.fake.widgetAction('boiler', key, params, { settings: {} });

  assert.equal(ack.success, true);
  assert.equal(t.writes().length, 1);
  assert.equal(t.writes()[0].method, 'POST');
  assert.match(t.writes()[0].url, /\/domestic-hot-water\/255\/boost$/);
  assert.equal(t.gladys.fake.lastState(id('hot-water:system-1-255:boost')), 1);

  await t.stop();
});

test('the refresh button reads the boiler once', async () => {
  const t = await startApp();
  const callsBefore = t.calls.length;

  const ack = await t.gladys.fake.widgetAction('boiler', 'refresh', undefined, { settings: {} });

  assert.equal(ack.success, true);
  assert.equal(t.calls.length, callsBefore + 1);

  await t.stop();
});

test('a button of an installation that is gone fails instead of guessing', async () => {
  const t = await startApp();

  const ack = await t.gladys.fake.widgetAction(
    'boiler',
    'hot_water_boost',
    { feature: id('hot-water:removed-255:boost'), value: 1 },
    { settings: {} },
  );

  assert.equal(ack.success, false);
  assert.equal(t.writes().length, 0);

  await t.stop();
});

test('before any configuration, the card says what to do', async () => {
  const t = await startApp({ config: {} });

  const { content } = (await t.gladys.fake.widgetGet('boiler', { settings: {} })).data;

  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(content.components[0].text.fr, /MiGo/);
  assert.equal(t.calls.length, 0);

  await t.stop();
});
