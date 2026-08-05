// -----------------------------------------------------------------------------
// Device type: BOILER (one per installation).
//
// Read-only counterpart of the thermostat: it carries what belongs to the
// appliance itself rather than to a room.
//   - the outdoor temperature measured by the outside sensor
//   - whether the boiler is currently producing heat
//   - the water pressure of the heating circuit
//
// Turning heating on and off lives on the thermostat, because that is what the
// API actually exposes: the operating mode is a property of a heating zone, not
// of the boiler.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { boilerIds, DEVICE_TYPES } from './externalIds.js';

const logger = createLogger({ name: 'boiler' });

export const FEATURE = {
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  STATE: 'state',
  WATER_PRESSURE: 'water-pressure',
};

export const boiler = {
  type: DEVICE_TYPES.BOILER,

  /**
   * Build the discovery payload of one installation.
   * @param {object} gladys - The SDK instance.
   * @param {object} context - Discovery context.
   * @param {object} context.system - Normalized system.
   * @returns {object} The device payload.
   */
  buildDevice(gladys, { system }) {
    const ids = boilerIds(gladys, system.id);

    const features = [
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
        name: 'Boiler state',
        external_id: ids.feature(FEATURE.STATE),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        // Mandatory even on a binary feature: t_device_feature.min/max are
        // NOT NULL, so omitting them fails device creation with a 422.
        min: 0,
        max: 1,
        // Reported by the appliance, never commanded: the user acts on the
        // thermostat, the boiler only says whether it is firing.
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ];

    // Not every installation reports its pressure (it needs a sensor on the
    // circuit), so the feature only exists when the value does.
    if (system.waterPressure !== null) {
      features.push({
        name: 'Water pressure',
        external_id: ids.feature(FEATURE.WATER_PRESSURE),
        category: DEVICE_FEATURE_CATEGORIES.PRESSURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.BAR,
        min: 0,
        max: 6,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });
    }

    // No `poll_frequency`: see the note in thermostat.js — the integration
    // refreshes on its own schedule rather than on Gladys's, whose intervals
    // are capped at one minute.
    return {
      name: `Saunier Duval ${system.productType ?? 'boiler'}`.trim(),
      external_id: ids.device,
      features,
    };
  },

  /**
   * Publish the current values of an installation.
   * @param {object} gladys - The SDK instance.
   * @param {object} context - Poll context.
   * @param {object} context.client - The API client.
   * @param {string} context.systemId - System identifier.
   */
  async onPoll(gladys, { client, systemId }) {
    const systems = await client.getSystems();
    const system = systems.find((candidate) => candidate.id === systemId);
    if (!system) {
      throw new Error(`System ${systemId} is no longer reported by the Saunier Duval cloud`);
    }
    const ids = boilerIds(gladys, systemId);

    const states = [
      {
        device_feature_external_id: ids.feature(FEATURE.STATE),
        state: system.heatingActive ? 1 : 0,
      },
    ];
    if (system.outdoorTemperature !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.OUTDOOR_TEMPERATURE),
        state: system.outdoorTemperature,
      });
    }
    if (system.waterPressure !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE.WATER_PRESSURE),
        state: system.waterPressure,
      });
    }

    logger.debug(
      `System ${systemId}: outdoor ${system.outdoorTemperature}°C, circuits ${system.circuitStates.join(', ')}`,
    );
    await gladys.publishStates(states);
  },
};
