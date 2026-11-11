// -----------------------------------------------------------------------------
// Device type: BOILER / INSTALLATION
//
// One device per installation, carrying what belongs to the system as a whole
// rather than to a heating zone: outdoor temperature (measured by the outdoor
// probe, or estimated by the gateway), heating water pressure — the one that
// tells you the installation needs a top-up — the current activity of the
// boiler, the fault codes it reports, and the ventilation boost.
//
// The ventilation boost is the airing function of the control. The Saunier
// Duval application offers it on every installation, with or without a
// ventilation unit, and so does this device: it is one switch for the whole
// installation, and the zones report it as their special function while it
// runs. That is where its state is read from.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { ZONE_SPECIAL_FUNCTIONS } from '../saunierDuval/const.js';
import { numericStates, round1, systemLabel, textStates } from './helpers.js';

const DEVICE_TYPE = 'boiler';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  OUTDOOR_TEMPERATURE_24H: 'outdoor-temperature-24h',
  WATER_PRESSURE: 'water-pressure',
  ACTIVITY: 'activity',
  TROUBLE_CODES: 'trouble-codes',
  TROUBLE_CODES_DETAIL: 'trouble-codes-detail',
  VENTILATION_BOOST: 'ventilation-boost',
};

/**
 * The fault / maintenance codes of an installation, flattened across its
 * appliances. `id` tells one occurrence from another, so a code that clears
 * and comes back is seen as a new fault.
 */
export function listTroubleCodes(troubleCodes) {
  return (troubleCodes ?? []).flatMap((appliance) =>
    (appliance.codes ?? []).map((code) => ({
      id: [appliance.serialNumber, code.code, code.occurrenceTimestamp].join('|'),
      code: String(code.code ?? ''),
      title: code.title ?? '',
      description: code.description ?? '',
      kind: code.type ?? '',
    })),
  );
}

/** Short description of the codes, e.g. "F.28 Ignition failure". */
function describeTroubleCodes(codes) {
  if (codes.length === 0) {
    return 'OK';
  }
  return codes
    .map((code) => [code.code, code.title].filter(Boolean).join(' '))
    .join(', ')
    .slice(0, 255);
}

/** Is the ventilation boost running? Any zone reporting it is enough. */
function isVentilationBoostActive(entry) {
  return (entry.system?.state?.zones ?? []).some(
    (zone) => zone.currentSpecialFunction === ZONE_SPECIAL_FUNCTIONS.VENTILATION_BOOST,
  );
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
  const troubleCodes = listTroubleCodes(entry.troubleCodes);
  const ventilationBoost = isVentilationBoostActive(entry);
  // `systemOff` wins: a stopped system still reports its last activity.
  const activity = state.systemOff ? 'OFF' : (state.energyManagerState ?? null);

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
      {
        // A plain on/off switch: Gladys has no dedicated "airing" feature, and
        // this is what the function is — started and stopped, nothing else.
        name: 'Ventilation boost',
        external_id: ids.feature(FEATURE.VENTILATION_BOOST),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        // The control ends the boost by itself: the state read back from the
        // boiler is the one that counts.
        has_feedback: true,
        keep_history: true,
      },
    ],
  };

  const states = [
    ...numericStates([
      [ids.feature(FEATURE.OUTDOOR_TEMPERATURE), round1(state.outdoorTemperature)],
      [ids.feature(FEATURE.OUTDOOR_TEMPERATURE_24H), round1(state.outdoorTemperatureAverage24h)],
      [ids.feature(FEATURE.WATER_PRESSURE), round1(state.systemWaterPressure)],
      [ids.feature(FEATURE.TROUBLE_CODES), troubleCodes.length],
      [ids.feature(FEATURE.VENTILATION_BOOST), ventilationBoost ? 1 : 0],
    ]),
    ...textStates([
      [ids.feature(FEATURE.ACTIVITY), activity],
      [ids.feature(FEATURE.TROUBLE_CODES_DETAIL), describeTroubleCodes(troubleCodes)],
    ]),
  ];

  const target = { systemId: entry.systemId, controlIdentifier: entry.controlIdentifier };

  return {
    kind: DEVICE_TYPE,
    systemId: entry.systemId,
    externalId: ids.device,
    device,
    states,
    commands: {
      [ids.feature(FEATURE.VENTILATION_BOOST)]: (client, value) => {
        logger.info(`Ventilation boost -> ${value === 1 ? 'ON' : 'OFF'}`);
        return client.setVentilationBoost(target, value === 1);
      },
    },
    // What the scenes and the dashboard widget read, already decoded: they
    // must not dig into the raw payload of the platform a second time.
    info: {
      name: systemLabel(entry.home),
      outdoorTemperature: round1(state.outdoorTemperature),
      waterPressure: round1(state.systemWaterPressure),
      activity,
      online: entry.online ?? null,
      troubleCodes,
      ventilationBoost,
      features: { ventilationBoost: ids.feature(FEATURE.VENTILATION_BOOST) },
    },
  };
}

export { DEVICE_TYPE as SYSTEM_DEVICE_TYPE, FEATURE as SYSTEM_FEATURES };
