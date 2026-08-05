// -----------------------------------------------------------------------------
// Device type: THERMOSTAT (one per heating zone).
//
// This is the device the user interacts with. It carries the four features that
// belong to a room:
//   - the measured temperature and humidity        (read only)
//   - the target temperature                       (read AND write)
//   - whether heating runs at all                  (read AND write)
//
// A Saunier Duval installation has one zone per heating circuit it controls; a
// standard house has exactly one, named after the zone configured in the MiGo
// app.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { MAX_SETPOINT, MIN_SETPOINT } from '../api/client.js';
import { DEVICE_TYPES, thermostatIds } from './externalIds.js';

const logger = createLogger({ name: 'thermostat' });

export const FEATURE = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  TARGET_TEMPERATURE: 'target-temperature',
  HEATING: 'heating',
};

export const thermostat = {
  type: DEVICE_TYPES.THERMOSTAT,

  /**
   * Build the discovery payload of one zone.
   * @param {object} gladys - The SDK instance.
   * @param {object} context - Discovery context.
   * @param {object} context.system - Normalized system.
   * @param {object} context.zone - Normalized zone.
   * @returns {object} The device payload.
   */
  buildDevice(gladys, { system, zone }) {
    const ids = thermostatIds(gladys, system.id, zone.index);

    const features = [
      {
        name: 'Temperature',
        external_id: ids.feature(FEATURE.TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -20,
        max: 60,
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
        // The controller confirms the setpoint it applied, which can differ
        // from the requested one (rounding, bounds).
        has_feedback: true,
        keep_history: true,
      },
      {
        name: 'Heating',
        external_id: ids.feature(FEATURE.HEATING),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
    ];

    // Only the room sensors of a MiGo Link report humidity: declaring the
    // feature on a zone that never publishes it would leave an empty tile.
    if (zone.humidity !== null) {
      features.splice(1, 0, {
        name: 'Humidity',
        external_id: ids.feature(FEATURE.HUMIDITY),
        category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });
    }

    // No `poll_frequency`: Gladys only accepts a closed set of intervals
    // capped at one minute, far too aggressive for a cloud that refreshes
    // every few minutes. The integration runs its own refresh loop instead,
    // at the interval configured by the user (see index.js).
    return {
      name: buildName(system, zone),
      external_id: ids.device,
      features,
    };
  },

  /**
   * Publish the current values of a zone.
   * @param {object} gladys - The SDK instance.
   * @param {object} context - Poll context.
   * @param {object} context.client - The API client.
   * @param {string} context.systemId - System identifier.
   * @param {number} context.zoneIndex - Zone index.
   */
  async onPoll(gladys, { client, systemId, zoneIndex }) {
    const { zone } = await client.getZone(systemId, zoneIndex);
    const ids = thermostatIds(gladys, systemId, zoneIndex);

    const states = [
      {
        device_feature_external_id: ids.feature(FEATURE.HEATING),
        state: zone.heatingEnabled ? 1 : 0,
      },
    ];
    // A sensor the gateway did not report this cycle is skipped rather than
    // published as 0, which would pollute the history with a fake reading.
    if (zone.currentTemperature !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.TEMPERATURE),
        state: zone.currentTemperature,
      });
    }
    if (zone.humidity !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.HUMIDITY),
        state: Math.round(zone.humidity),
      });
    }
    if (zone.targetTemperature !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.TARGET_TEMPERATURE),
        state: zone.targetTemperature,
      });
    }

    logger.debug(
      `Zone ${zoneIndex}: ${zone.currentTemperature}°C, target ${zone.targetTemperature}°C, mode ${zone.operationMode}`,
    );
    await gladys.publishStates(states);
  },

  /**
   * Run a user command on a zone.
   * @param {object} gladys - The SDK instance.
   * @param {object} context - Command context.
   * @param {object} context.client - The API client.
   * @param {object} context.config - Normalized configuration.
   * @param {string} context.systemId - System identifier.
   * @param {number} context.zoneIndex - Zone index.
   * @param {string} context.featureKey - Feature being actioned.
   * @param {string} context.featureExternalId - External id of that feature.
   * @param {number} context.value - Requested value.
   */
  async onSetValue(
    gladys,
    { client, config, systemId, zoneIndex, featureKey, featureExternalId, value },
  ) {
    if (featureKey === FEATURE.TARGET_TEMPERATURE) {
      logger.info(`Setting the target temperature of zone ${zoneIndex} to ${value}°C`);
      const applied = await client.setTargetTemperature({
        systemId,
        zoneIndex,
        temperature: value,
        durationHours: config.quick_veto_duration,
      });
      // has_feedback: publish what the controller accepted, not what was asked.
      await gladys.publishState(featureExternalId, applied);
      return;
    }

    if (featureKey === FEATURE.HEATING) {
      const enabled = value === 1;
      logger.info(`Turning heating ${enabled ? 'on' : 'off'} on zone ${zoneIndex}`);
      await client.setHeatingEnabled({
        systemId,
        zoneIndex,
        enabled,
        onMode: config.heating_on_mode,
      });
      await gladys.publishState(featureExternalId, enabled ? 1 : 0);
      return;
    }

    // Throwing acks the command as failed, so the Gladys UI shows the failure
    // instead of silently pretending it worked.
    throw new Error(`Feature "${featureKey}" of a thermostat cannot be controlled`);
  },
};

/**
 * Name the device the way the user will recognize it. Installations with a
 * single zone get the home name alone, which is what most houses look like.
 * @param {object} system - Normalized system.
 * @param {object} zone - Normalized zone.
 * @returns {string} The device name.
 */
export function buildName(system, zone) {
  const zones = system.zones ?? [];
  if (zones.length <= 1) {
    return `Saunier Duval ${system.name}`.trim();
  }
  return `Saunier Duval ${system.name} - ${zone.name}`.trim();
}
