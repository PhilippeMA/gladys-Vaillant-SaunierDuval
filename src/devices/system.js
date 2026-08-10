// -----------------------------------------------------------------------------
// Device type: BOILER / INSTALLATION
//
// One read-only device per installation, carrying what belongs to the system
// as a whole rather than to a heating zone: outdoor temperature (measured by
// the outdoor probe, or estimated by the gateway), heating water pressure —
// the one that tells you the installation needs a top-up — the current
// activity of the boiler, and the fault codes it reports.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { numericStates, round1, systemLabel, textStates } from './helpers.js';

const DEVICE_TYPE = 'boiler';

const FEATURE = {
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  OUTDOOR_TEMPERATURE_24H: 'outdoor-temperature-24h',
  WATER_PRESSURE: 'water-pressure',
  ACTIVITY: 'activity',
  TROUBLE_CODES: 'trouble-codes',
  TROUBLE_CODES_DETAIL: 'trouble-codes-detail',
};

/** Total number of fault / maintenance codes across the appliances. */
function countTroubleCodes(troubleCodes) {
  return (troubleCodes ?? []).reduce((total, device) => total + (device.codes?.length ?? 0), 0);
}

/** Short description of the codes, e.g. "F.28 Ignition failure". */
function describeTroubleCodes(troubleCodes) {
  const codes = (troubleCodes ?? []).flatMap((device) => device.codes ?? []);
  if (codes.length === 0) {
    return 'OK';
  }
  return codes
    .map((code) => [code.code, code.title].filter(Boolean).join(' '))
    .join(', ')
    .slice(0, 255);
}

/**
 * Build the boiler device of one installation.
 *
 * @param {object} gladys the SDK instance
 * @param {object} entry one entry of the client snapshot
 * @returns {object} a device model (device payload + states)
 */
export function buildSystemDevice(gladys, entry) {
  const ids = gladys.externalIds(DEVICE_TYPE, entry.systemId);
  const state = entry.system?.state?.system ?? {};

  const device = {
    name: `${systemLabel(entry.home)} boiler`,
    external_id: ids.device,
    features: [
      {
        name: 'Outdoor temperature',
        external_id: ids.feature(FEATURE.OUTDOOR_TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -50,
        max: 60,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Outdoor temperature (24h average)',
        external_id: ids.feature(FEATURE.OUTDOOR_TEMPERATURE_24H),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -50,
        max: 60,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Water pressure',
        external_id: ids.feature(FEATURE.WATER_PRESSURE),
        category: DEVICE_FEATURE_CATEGORIES.PRESSURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.BAR,
        min: 0,
        max: 5,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Activity',
        external_id: ids.feature(FEATURE.ACTIVITY),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // A text feature has no numeric range, but `min` and `max` are NOT NULL
        // in the Gladys schema: 0/0 is the "not applicable" encoding.
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        // Number of active codes: 0 means "nothing to report". A scene can
        // watch this one; the detail is in the feature below.
        name: 'Fault codes',
        external_id: ids.feature(FEATURE.TROUBLE_CODES),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Fault details',
        external_id: ids.feature(FEATURE.TROUBLE_CODES_DETAIL),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };

  const states = [
    ...numericStates([
      [ids.feature(FEATURE.OUTDOOR_TEMPERATURE), round1(state.outdoorTemperature)],
      [ids.feature(FEATURE.OUTDOOR_TEMPERATURE_24H), round1(state.outdoorTemperatureAverage24h)],
      [ids.feature(FEATURE.WATER_PRESSURE), round1(state.systemWaterPressure)],
      [ids.feature(FEATURE.TROUBLE_CODES), countTroubleCodes(entry.troubleCodes)],
    ]),
    ...textStates([
      [
        ids.feature(FEATURE.ACTIVITY),
        // `systemOff` wins: a stopped system still reports its last activity.
        state.systemOff ? 'OFF' : (state.energyManagerState ?? null),
      ],
      [ids.feature(FEATURE.TROUBLE_CODES_DETAIL), describeTroubleCodes(entry.troubleCodes)],
    ]),
  ];

  return { externalId: ids.device, device, states, commands: {} };
}

export { DEVICE_TYPE as SYSTEM_DEVICE_TYPE, FEATURE as SYSTEM_FEATURES };
