// -----------------------------------------------------------------------------
// Device type: HEATING ZONE (thermostat)
//
// One device per zone declared in the boiler: the room temperature, the
// setpoint the user can change, the operating mode, and whether the associated
// circuit is currently heating.
//
// Writing the setpoint is the subtle part. The boiler has no single "target
// temperature" register: it depends on the mode the zone runs in.
//   - manual mode   -> we write the manual setpoint, which holds until changed;
//   - schedule mode -> writing a permanent setpoint would silently defeat the
//     user's schedule, so we start a "quick veto": a temporary override that
//     expires on its own and gives back the schedule. This is exactly what the
//     official application does when you turn the dial on a scheduled zone.
//   - zone off      -> nothing to write, the command is refused with a clear
//     message rather than silently ignored.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  createLogger,
} from '@gladysassistant/integration-sdk';
import { ZONE_SPECIAL_FUNCTIONS } from '../saunierDuval/const.js';
import { numericStates, round1, systemLabel } from './helpers.js';
import {
  THERMOSTAT_MODE,
  circuitStateToOperatingState,
  supportedZoneModes,
  zoneManualMode,
  zoneModeToGladys,
  zoneModeToPlatform,
  zoneScheduledMode,
} from './mappings.js';

const DEVICE_TYPE = 'zone';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  TARGET_TEMPERATURE: 'target-temperature',
  MODE: 'mode',
  OPERATING_STATE: 'operating-state',
};

/** Range accepted by the boiler for a room setpoint. */
const MIN_SETPOINT = 5;
const MAX_SETPOINT = 30;

/** Merge the three sections the platform splits a zone into. */
function readZone(entry, index) {
  const system = entry.system ?? {};
  const find = (list) => (list ?? []).find((item) => item.index === index) ?? {};
  return {
    state: find(system.state?.zones),
    properties: find(system.properties?.zones),
    configuration: find(system.configuration?.zones),
  };
}

/**
 * The setpoint to show in the interface — the value the input box is filled
 * with, and the one a user would edit.
 *
 * NOT `desiredRoomTemperatureSetpoint`, which is the demand of the moment: the
 * boiler reports it as 0 whenever nothing is being asked of the heating (a
 * scheduled zone outside its slots, summer mode). Publishing that would fill
 * the box with a 0 the boiler never accepts as a setpoint.
 *
 * So we publish the setpoint that is actually being edited:
 *   - while a temporary override runs, the override temperature — it IS the
 *     setpoint in force, and the value the user just set;
 *   - otherwise the manual setpoint (`manualModeSetpointHeating`, or
 *     `dayTemperatureHeating` on a MiPro / Exacontrol control), which is the
 *     temperature the Saunier Duval application shows.
 * Values outside what the boiler accepts as a setpoint are ignored rather than
 * published: a feature keeps its previous value instead of showing a 0.
 */
function readTargetTemperature(zone) {
  const heating = zone.configuration.heating ?? {};
  const override = zone.state.currentSpecialFunction === ZONE_SPECIAL_FUNCTIONS.QUICK_VETO;
  const manualSetpoint = heating.manualModeSetpointHeating ?? heating.dayTemperatureHeating;

  const candidates = override
    ? [zone.state.desiredRoomTemperatureSetpoint, manualSetpoint]
    : [manualSetpoint, zone.state.desiredRoomTemperatureSetpoint];

  for (const candidate of candidates) {
    const value = round1(candidate);
    if (value !== null && value >= MIN_SETPOINT && value <= MAX_SETPOINT) {
      return value;
    }
  }
  return null;
}

/** State of the circuit a zone is bound to, which tells if it is heating now. */
function readAssociatedCircuit(entry, zoneProperties) {
  const circuits = entry.system?.state?.circuits ?? [];
  const circuitIndex = zoneProperties.associatedCircuitIndex;
  if (circuitIndex === undefined || circuitIndex === null) {
    return circuits[0] ?? {};
  }
  return circuits.find((circuit) => circuit.index === circuitIndex) ?? {};
}

/**
 * Build one heating zone device.
 *
 * @param {object} gladys the SDK instance
 * @param {object} entry one entry of the client snapshot
 * @param {number} index index of the zone in the boiler
 * @param {object} config the integration configuration
 */
export function buildZoneDevice(gladys, entry, index, config) {
  const zone = readZone(entry, index);
  const platformId = `${entry.systemId}-${index}`;
  const ids = gladys.externalIds(DEVICE_TYPE, platformId);

  const zoneName = (zone.configuration.general?.name ?? '').trim() || `Zone ${index + 1}`;
  const heating = zone.configuration.heating ?? {};
  const circuit = readAssociatedCircuit(entry, zone.properties);

  const features = [
    {
      name: 'Room temperature',
      external_id: ids.feature(FEATURE.TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: -10,
      max: 50,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: 'Target temperature',
      external_id: ids.feature(FEATURE.TARGET_TEMPERATURE),
      category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
      type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
      unit: DEVICE_FEATURE_UNITS.CELSIUS,
      min: MIN_SETPOINT,
      max: MAX_SETPOINT,
      read_only: false,
      // The boiler confirms asynchronously: we publish the value we read back
      // from the platform after the command, not the one we requested.
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Mode',
      external_id: ids.feature(FEATURE.MODE),
      category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
      type: DEVICE_FEATURE_TYPES.THERMOSTAT.MODE,
      min: THERMOSTAT_MODE.OFF,
      max: THERMOSTAT_MODE.AUTO,
      // Without this list Gladys offers its whole mode enumeration, including
      // a "Cooling" button no Saunier Duval boiler can honour.
      supported_options: supportedZoneModes(entry.controlIdentifier),
      read_only: false,
      has_feedback: true,
      keep_history: true,
    },
    {
      name: 'Heating',
      external_id: ids.feature(FEATURE.OPERATING_STATE),
      category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
      type: DEVICE_FEATURE_TYPES.THERMOSTAT.OPERATING_STATE,
      min: 0,
      max: 2,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  // Only the zones whose thermostat measures humidity report it: declaring the
  // feature anyway would create a sensor that never gets a value.
  if (zone.state.currentRoomHumidity !== undefined && zone.state.currentRoomHumidity !== null) {
    features.splice(1, 0, {
      name: 'Room humidity',
      external_id: ids.feature(FEATURE.HUMIDITY),
      category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
      // `decimal`, not `integer`: Gladys only names and illustrates the decimal
      // humidity sensor, so an integer one shows up as "undefined" with no
      // pictogram.
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    });
  }

  const device = {
    name: `${systemLabel(entry.home)} – ${zoneName}`,
    external_id: ids.device,
    features,
  };

  const states = numericStates([
    [ids.feature(FEATURE.TEMPERATURE), round1(zone.state.currentRoomTemperature)],
    [ids.feature(FEATURE.HUMIDITY), round1(zone.state.currentRoomHumidity)],
    [ids.feature(FEATURE.TARGET_TEMPERATURE), readTargetTemperature(zone)],
    [
      ids.feature(FEATURE.MODE),
      zoneModeToGladys(entry.controlIdentifier, heating.operationModeHeating),
    ],
    [ids.feature(FEATURE.OPERATING_STATE), circuitStateToOperatingState(circuit.circuitState)],
  ]);

  /** Everything a command needs to address this zone on the platform. */
  const target = {
    systemId: entry.systemId,
    controlIdentifier: entry.controlIdentifier,
    index,
    currentSpecialFunction: zone.state.currentSpecialFunction,
  };

  return {
    externalId: ids.device,
    device,
    states,
    commands: {
      [ids.feature(FEATURE.TARGET_TEMPERATURE)]: (client, value) =>
        setTargetTemperature(client, target, heating.operationModeHeating, value, config, zoneName),
      // `async` on purpose: an unsupported mode must come back as a rejected
      // promise, like every other command failure, not as a synchronous throw.
      [ids.feature(FEATURE.MODE)]: async (client, value) =>
        client.setZoneOperatingMode(target, zoneModeToPlatform(entry.controlIdentifier, value)),
    },
  };
}

/**
 * Apply a new setpoint, with the write the current mode calls for.
 * Exported for the unit tests.
 */
export async function setTargetTemperature(
  client,
  target,
  operationMode,
  temperature,
  config,
  zoneName = 'zone',
) {
  const { controlIdentifier } = target;

  if (operationMode === zoneManualMode(controlIdentifier)) {
    logger.info(`${zoneName}: manual setpoint -> ${temperature} °C`);
    return client.setZoneManualSetpoint(target, temperature);
  }

  if (operationMode === zoneScheduledMode(controlIdentifier)) {
    const duration = config.quick_veto_duration;
    logger.info(`${zoneName}: temporary override -> ${temperature} °C for ${duration} h`);
    return client.setZoneQuickVeto(target, temperature, duration);
  }

  // OFF, holiday, or any mode the boiler does not let us write a setpoint in.
  throw new Error(
    `Cannot set a temperature on ${zoneName}: the zone is in ${operationMode ?? 'an unknown'} mode. Change its mode first.`,
  );
}

export { DEVICE_TYPE as ZONE_DEVICE_TYPE, FEATURE as ZONE_FEATURES };
