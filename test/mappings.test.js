// -----------------------------------------------------------------------------
// The boiler and Gladys do not speak the same language, and the two controller
// families do not speak the same language either. A wrong entry in these
// tables would send a valid-looking command that the boiler silently ignores,
// or show the wrong mode in the interface.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
  WATER_HEATER_MODE,
  circuitStateToOperatingState,
  dhwModeToGladys,
  dhwModeToPlatform,
  supportedDhwModes,
  supportedZoneModes,
  zoneManualMode,
  zoneModeToGladys,
  zoneModeToPlatform,
  zoneScheduledMode,
} from '../src/devices/mappings.js';

test('zone modes survive a round trip on both controller families', () => {
  for (const controlIdentifier of ['tli', 'vrc700']) {
    for (const value of [THERMOSTAT_MODE.OFF, THERMOSTAT_MODE.HEATING, THERMOSTAT_MODE.AUTO]) {
      const platformMode = zoneModeToPlatform(controlIdentifier, value);
      assert.equal(
        zoneModeToGladys(controlIdentifier, platformMode),
        value,
        `${controlIdentifier}: ${value} -> ${platformMode} -> back to something else`,
      );
    }
  }
});

test('each controller family keeps its own vocabulary', () => {
  assert.equal(zoneModeToPlatform('tli', THERMOSTAT_MODE.AUTO), 'TIME_CONTROLLED');
  assert.equal(zoneModeToPlatform('vrc700', THERMOSTAT_MODE.AUTO), 'AUTO');
  assert.equal(zoneManualMode('tli'), 'MANUAL');
  assert.equal(zoneManualMode('vrc700'), 'DAY');
  assert.equal(zoneScheduledMode('tli'), 'TIME_CONTROLLED');
  assert.equal(zoneScheduledMode('vrc700'), 'AUTO');
});

test('the vrc700 set-back mode is read as heating, not as off', () => {
  // The zone still heats, at the reduced temperature: reading it as OFF would
  // make a scene believe the heating is stopped.
  assert.equal(zoneModeToGladys('vrc700', 'SET_BACK'), THERMOSTAT_MODE.HEATING);
});

test('an unknown mode reads as null instead of a wrong value', () => {
  assert.equal(zoneModeToGladys('tli', 'SOMETHING_NEW'), null);
  assert.equal(dhwModeToGladys('tli', 'SOMETHING_NEW'), null);
});

test('cooling is refused on a boiler that cannot cool', () => {
  assert.throws(() => zoneModeToPlatform('tli', THERMOSTAT_MODE.COOLING), /not supported/);
  assert.throws(() => dhwModeToPlatform('tli', WATER_HEATER_MODE.ECO), /not supported/);
});

test('hot water modes survive a round trip on both controller families', () => {
  for (const controlIdentifier of ['tli', 'vrc700']) {
    for (const value of [
      WATER_HEATER_MODE.OFF,
      WATER_HEATER_MODE.MANUAL,
      WATER_HEATER_MODE.PROGRAM,
    ]) {
      const platformMode = dhwModeToPlatform(controlIdentifier, value);
      assert.equal(dhwModeToGladys(controlIdentifier, platformMode), value);
    }
  }
});

test('the circuit state becomes the operating state of the zone', () => {
  assert.equal(circuitStateToOperatingState('HEATING'), THERMOSTAT_OPERATING_STATE.HEATING);
  assert.equal(circuitStateToOperatingState('STANDBY'), THERMOSTAT_OPERATING_STATE.IDLE);
  assert.equal(circuitStateToOperatingState('COOLING'), THERMOSTAT_OPERATING_STATE.COOLING);
  assert.equal(circuitStateToOperatingState(undefined), null);
});

test('the offered heating modes are the three the boiler actually has', () => {
  // The Saunier Duval application offers manual, schedule and off — in that
  // order. Cooling must not be offered: the boiler cannot do it.
  for (const controlIdentifier of ['tli', 'vrc700']) {
    const options = supportedZoneModes(controlIdentifier);
    assert.deepEqual(
      options.map((option) => option.value),
      [THERMOSTAT_MODE.HEATING, THERMOSTAT_MODE.AUTO, THERMOSTAT_MODE.OFF],
    );
    assert.ok(!options.some((option) => option.value === THERMOSTAT_MODE.COOLING));
  }
});

test('the offered hot water modes are the three the boiler actually has', () => {
  for (const controlIdentifier of ['tli', 'vrc700']) {
    const options = supportedDhwModes(controlIdentifier);
    assert.deepEqual(
      options.map((option) => option.value),
      [WATER_HEATER_MODE.MANUAL, WATER_HEATER_MODE.PROGRAM, WATER_HEATER_MODE.OFF],
    );
    // Gladys knows seven modes; the four others must not be offered.
    for (const absent of [WATER_HEATER_MODE.AUTO, WATER_HEATER_MODE.ECO, WATER_HEATER_MODE.BOOST]) {
      assert.ok(!options.some((option) => option.value === absent));
    }
  }
});

test('every offered mode has a command behind it', () => {
  // The lists are derived from the write tables, so an option can never be
  // rendered without a matching command — this is what that guarantees.
  for (const controlIdentifier of ['tli', 'vrc700']) {
    for (const option of supportedZoneModes(controlIdentifier)) {
      assert.ok(zoneModeToPlatform(controlIdentifier, option.value));
    }
    for (const option of supportedDhwModes(controlIdentifier)) {
      assert.ok(dhwModeToPlatform(controlIdentifier, option.value));
    }
  }
});

test('supported options carry what the Gladys schema requires', () => {
  const options = [...supportedZoneModes('tli'), ...supportedDhwModes('tli')];
  for (const option of options) {
    assert.ok(Number.isInteger(option.value), 'value must be an integer');
    assert.ok(
      typeof option.label === 'string' && option.label.trim().length > 0,
      'label must be a non-empty string',
    );
    assert.ok(Number.isInteger(option.sort_order), 'sort_order must be an integer');
  }
});

test('an unknown controller family falls back on the modern vocabulary', () => {
  // The platform could introduce a family we do not know yet: falling back on
  // the tli tables keeps the integration usable instead of crashing.
  assert.equal(zoneModeToPlatform('brand-new', THERMOSTAT_MODE.AUTO), 'TIME_CONTROLLED');
});
