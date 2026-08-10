// -----------------------------------------------------------------------------
// Translation between the vocabulary of the boiler and the one of Gladys.
//
// Gladys features carry numeric states, from fixed enumerations
// (THERMOSTAT_MODE, THERMOSTAT_OPERATING_STATE, WATER_HEATER_MODE of
// `server/utils/constants.js`). The platform speaks in strings, and not even
// the same strings on both controller families. Everything that maps one to
// the other lives here, so the device modules stay readable.
// -----------------------------------------------------------------------------

import { CONTROL_IDENTIFIERS } from '../saunierDuval/const.js';

/** Gladys THERMOSTAT_MODE. */
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };

/** Gladys THERMOSTAT_OPERATING_STATE. */
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };

/** Gladys WATER_HEATER_MODE. */
export const WATER_HEATER_MODE = {
  OFF: 0,
  AUTO: 1,
  ECO: 2,
  BOOST: 3,
  MANUAL: 4,
  AWAY: 5,
  PROGRAM: 6,
};

/**
 * Zone heating modes.
 *
 * `SET_BACK` (vrc700 only) means "permanently at the reduced temperature": no
 * Gladys value says exactly that, and since the zone is still heating we read
 * it as HEATING. Writing HEATING back gives the comfort mode (`DAY`), which is
 * the mode a user asking for "heating" expects.
 */
const ZONE_MODES = {
  [CONTROL_IDENTIFIERS.TLI]: {
    toGladys: {
      OFF: THERMOSTAT_MODE.OFF,
      MANUAL: THERMOSTAT_MODE.HEATING,
      TIME_CONTROLLED: THERMOSTAT_MODE.AUTO,
    },
    toPlatform: {
      [THERMOSTAT_MODE.OFF]: 'OFF',
      [THERMOSTAT_MODE.HEATING]: 'MANUAL',
      [THERMOSTAT_MODE.AUTO]: 'TIME_CONTROLLED',
    },
    /** Mode in which the setpoint is a plain manual setpoint. */
    manual: 'MANUAL',
    scheduled: 'TIME_CONTROLLED',
  },
  [CONTROL_IDENTIFIERS.VRC700]: {
    toGladys: {
      OFF: THERMOSTAT_MODE.OFF,
      DAY: THERMOSTAT_MODE.HEATING,
      SET_BACK: THERMOSTAT_MODE.HEATING,
      AUTO: THERMOSTAT_MODE.AUTO,
    },
    toPlatform: {
      [THERMOSTAT_MODE.OFF]: 'OFF',
      [THERMOSTAT_MODE.HEATING]: 'DAY',
      [THERMOSTAT_MODE.AUTO]: 'AUTO',
    },
    manual: 'DAY',
    scheduled: 'AUTO',
  },
};

/** Domestic hot water modes, same idea. */
const DHW_MODES = {
  [CONTROL_IDENTIFIERS.TLI]: {
    toGladys: {
      OFF: WATER_HEATER_MODE.OFF,
      MANUAL: WATER_HEATER_MODE.MANUAL,
      TIME_CONTROLLED: WATER_HEATER_MODE.PROGRAM,
    },
    toPlatform: {
      [WATER_HEATER_MODE.OFF]: 'OFF',
      [WATER_HEATER_MODE.MANUAL]: 'MANUAL',
      [WATER_HEATER_MODE.PROGRAM]: 'TIME_CONTROLLED',
    },
  },
  [CONTROL_IDENTIFIERS.VRC700]: {
    toGladys: {
      OFF: WATER_HEATER_MODE.OFF,
      DAY: WATER_HEATER_MODE.MANUAL,
      AUTO: WATER_HEATER_MODE.PROGRAM,
    },
    toPlatform: {
      [WATER_HEATER_MODE.OFF]: 'OFF',
      [WATER_HEATER_MODE.MANUAL]: 'DAY',
      [WATER_HEATER_MODE.PROGRAM]: 'AUTO',
    },
  },
};

function table(map, controlIdentifier) {
  return map[controlIdentifier] ?? map[CONTROL_IDENTIFIERS.TLI];
}

// --- Modes offered in the interface ------------------------------------------
//
// Without a `supported_options` list, Gladys renders the whole enumeration it
// knows: a boiler would be offered a "Cooling" button it cannot honour, and a
// hot water circuit would show Eco / Boost / Away modes that do not exist on
// it. Declaring the supported values removes them.
//
// The lists are DERIVED from the write tables above, so a mode can never be
// offered in the interface without a matching command — and the order is the
// one of the Saunier Duval application, so the two read alike.
//
// The `label` is only a fallback: Gladys translates the value itself when it
// knows it (value 1 shows as "Chauffage" / "Heating"). It is what the user
// sees if a future Gladys meets a value it has no wording for.

const ZONE_MODE_DISPLAY = [
  { value: THERMOSTAT_MODE.HEATING, label: 'Manual' },
  { value: THERMOSTAT_MODE.AUTO, label: 'Scheduled' },
  { value: THERMOSTAT_MODE.OFF, label: 'Off' },
];

const DHW_MODE_DISPLAY = [
  { value: WATER_HEATER_MODE.MANUAL, label: 'Manual' },
  { value: WATER_HEATER_MODE.PROGRAM, label: 'Scheduled' },
  { value: WATER_HEATER_MODE.OFF, label: 'Off' },
];

function supportedOptions(display, writeTable) {
  return display
    .filter((option) => writeTable[option.value])
    .map((option, index) => ({ ...option, sort_order: index }));
}

/** Heating modes this controller family accepts, for the Gladys interface. */
export function supportedZoneModes(controlIdentifier) {
  return supportedOptions(ZONE_MODE_DISPLAY, table(ZONE_MODES, controlIdentifier).toPlatform);
}

/** Hot water modes this controller family accepts, for the Gladys interface. */
export function supportedDhwModes(controlIdentifier) {
  return supportedOptions(DHW_MODE_DISPLAY, table(DHW_MODES, controlIdentifier).toPlatform);
}

/** Platform zone mode -> Gladys THERMOSTAT_MODE (null when unknown). */
export function zoneModeToGladys(controlIdentifier, mode) {
  return table(ZONE_MODES, controlIdentifier).toGladys[mode] ?? null;
}

/** Gladys THERMOSTAT_MODE -> platform zone mode. Throws on an unsupported value. */
export function zoneModeToPlatform(controlIdentifier, value) {
  const mode = table(ZONE_MODES, controlIdentifier).toPlatform[value];
  if (!mode) {
    throw new Error(`Heating mode ${value} is not supported by this boiler`);
  }
  return mode;
}

/** Names of the modes in which a zone follows a manual setpoint / a schedule. */
export function zoneManualMode(controlIdentifier) {
  return table(ZONE_MODES, controlIdentifier).manual;
}
export function zoneScheduledMode(controlIdentifier) {
  return table(ZONE_MODES, controlIdentifier).scheduled;
}

/** Platform hot water mode -> Gladys WATER_HEATER_MODE (null when unknown). */
export function dhwModeToGladys(controlIdentifier, mode) {
  return table(DHW_MODES, controlIdentifier).toGladys[mode] ?? null;
}

/** Gladys WATER_HEATER_MODE -> platform hot water mode. */
export function dhwModeToPlatform(controlIdentifier, value) {
  const mode = table(DHW_MODES, controlIdentifier).toPlatform[value];
  if (!mode) {
    throw new Error(`Hot water mode ${value} is not supported by this boiler`);
  }
  return mode;
}

/** Circuit state reported by the boiler -> Gladys THERMOSTAT_OPERATING_STATE. */
export function circuitStateToOperatingState(circuitState) {
  switch (circuitState) {
    case 'HEATING':
      return THERMOSTAT_OPERATING_STATE.HEATING;
    case 'COOLING':
      return THERMOSTAT_OPERATING_STATE.COOLING;
    case 'STANDBY':
      return THERMOSTAT_OPERATING_STATE.IDLE;
    default:
      return null;
  }
}
