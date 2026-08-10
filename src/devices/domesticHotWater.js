// -----------------------------------------------------------------------------
// Device type: DOMESTIC HOT WATER (water heater)
//
// One device per hot water circuit: the temperature of the tank, the tapping
// setpoint, the operating mode, and the boost — the "I want hot water now"
// button, which the boiler runs once and then clears by itself.
//
// Combi boilers without a tank still expose a hot water circuit (index 255),
// where the setpoint is the comfort tapping temperature.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { DHW_SPECIAL_FUNCTIONS } from '../saunierDuval/const.js';
import { dhwSection } from '../saunierDuval/client.js';
import { numericStates, round1, systemLabel } from './helpers.js';
import {
  WATER_HEATER_MODE,
  dhwModeToGladys,
  dhwModeToPlatform,
  supportedDhwModes,
} from './mappings.js';

const DEVICE_TYPE = 'hot-water';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  TEMPERATURE: 'temperature',
  TARGET_TEMPERATURE: 'target-temperature',
  MODE: 'mode',
  BOOST: 'boost',
  HEATING: 'heating',
};

/** Fallback range when the boiler does not advertise its own limits. */
const DEFAULT_MIN_SETPOINT = 35;
const DEFAULT_MAX_SETPOINT = 70;

/** Merge the three sections the platform splits a hot water circuit into. */
function readDhw(entry, index) {
  const system = entry.system ?? {};
  const find = (section) => dhwSection(section).find((item) => item.index === index) ?? {};
  return {
    state: find(system.state),
    properties: find(system.properties),
    configuration: find(system.configuration),
  };
}

/**
 * Build one hot water device.
 *
 * @param {object} gladys the SDK instance
 * @param {object} entry one entry of the client snapshot
 * @param {number} index index of the circuit in the boiler (often 255)
 */
export function buildDomesticHotWaterDevice(gladys, entry, index) {
  const dhw = readDhw(entry, index);
  const platformId = `${entry.systemId}-${index}`;
  const ids = gladys.externalIds(DEVICE_TYPE, platformId);

  const minSetpoint = Number(dhw.properties.minSetpoint ?? DEFAULT_MIN_SETPOINT);
  const maxSetpoint = Number(dhw.properties.maxSetpoint ?? DEFAULT_MAX_SETPOINT);
  const systemState = entry.system?.state?.system ?? {};
  const isBoosting = dhw.state.currentSpecialFunction === DHW_SPECIAL_FUNCTIONS.CYLINDER_BOOST;

  const features = [
    {
      name: 'Water temperature',
      external_id: ids.feature(FEATURE.TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: 0,
      max: 90,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: 'Target temperature',
      external_id: ids.feature(FEATURE.TARGET_TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.WATER_HEATER,
      type: DEVICE_FEATURE_TYPES.WATER_HEATER.TARGET_TEMPERATURE,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: minSetpoint,
      max: maxSetpoint,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Mode',
      external_id: ids.feature(FEATURE.MODE),
      category: DEVICE_FEATURE_CATEGORIES.WATER_HEATER,
      type: DEVICE_FEATURE_TYPES.WATER_HEATER.MODE,
      min: WATER_HEATER_MODE.OFF,
      max: WATER_HEATER_MODE.PROGRAM,
      // Gladys knows seven water heater modes; this boiler has three. Without
      // the list, Eco / Boost / Away / Auto buttons would be offered and would
      // simply be refused by the platform.
      supported_options: supportedDhwModes(entry.controlIdentifier),
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Boost',
      external_id: ids.feature(FEATURE.BOOST),
      category: DEVICE_FEATURE_CATEGORIES.WATER_HEATER,
      type: DEVICE_FEATURE_TYPES.WATER_HEATER.BOOST,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      // The boiler does not report a dedicated "heating water" flag: its energy
      // manager tells us what it is busy with, and DHW means the hot water.
      name: 'Heating water',
      external_id: ids.feature(FEATURE.HEATING),
      category: DEVICE_FEATURE_CATEGORIES.WATER_HEATER,
      type: DEVICE_FEATURE_TYPES.WATER_HEATER.HEATING,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  const device = {
    name: `${systemLabel(entry.home)} – Hot water`,
    external_id: ids.device,
    features,
  };

  const states = numericStates([
    [ids.feature(FEATURE.TEMPERATURE), round1(dhw.state.currentDhwTemperature)],
    [ids.feature(FEATURE.TARGET_TEMPERATURE), round1(dhw.configuration.tappingSetpoint)],
    [
      ids.feature(FEATURE.MODE),
      dhwModeToGladys(entry.controlIdentifier, dhw.configuration.operationModeDhw),
    ],
    [ids.feature(FEATURE.BOOST), isBoosting ? 1 : 0],
    [ids.feature(FEATURE.HEATING), systemState.energyManagerState === 'DHW' ? 1 : 0],
  ]);

  const target = {
    systemId: entry.systemId,
    controlIdentifier: entry.controlIdentifier,
    index,
  };

  return {
    externalId: ids.device,
    device,
    states,
    commands: {
      [ids.feature(FEATURE.TARGET_TEMPERATURE)]: (client, value) => {
        const clamped = Math.min(Math.max(value, minSetpoint), maxSetpoint);
        logger.info(`Hot water setpoint -> ${clamped} °C`);
        return client.setDomesticHotWaterTemperature(target, clamped);
      },
      // `async` on purpose: an unsupported mode must come back as a rejected
      // promise, like every other command failure, not as a synchronous throw.
      [ids.feature(FEATURE.MODE)]: async (client, value) =>
        client.setDomesticHotWaterOperationMode(
          target,
          dhwModeToPlatform(entry.controlIdentifier, value),
        ),
      [ids.feature(FEATURE.BOOST)]: (client, value) => {
        logger.info(`Hot water boost -> ${value === 1 ? 'ON' : 'OFF'}`);
        return client.setDomesticHotWaterBoost(target, value === 1);
      },
    },
  };
}

export { DEVICE_TYPE as DHW_DEVICE_TYPE, FEATURE as DHW_FEATURES };
