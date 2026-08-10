// -----------------------------------------------------------------------------
// Device type: HEATING CIRCUIT
//
// Read-only device per hydraulic circuit: the flow temperature actually
// leaving the boiler and the setpoint its heating curve asked for. Watching
// the two side by side is how you see whether the boiler keeps up, and whether
// the heating curve is set too high — the reading that tells you if the
// installation is over-consuming.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { numericStates, round1, systemLabel, textStates } from './helpers.js';

const DEVICE_TYPE = 'circuit';

const FEATURE = {
  FLOW_TEMPERATURE: 'flow-temperature',
  FLOW_SETPOINT: 'flow-setpoint',
  STATE: 'state',
};

/**
 * Build one heating circuit device.
 *
 * @param {object} gladys the SDK instance
 * @param {object} entry one entry of the client snapshot
 * @param {number} index index of the circuit in the boiler
 */
export function buildCircuitDevice(gladys, entry, index) {
  const platformId = `${entry.systemId}-${index}`;
  const ids = gladys.externalIds(DEVICE_TYPE, platformId);
  const state =
    (entry.system?.state?.circuits ?? []).find((circuit) => circuit.index === index) ?? {};

  const device = {
    name: `${systemLabel(entry.home)} – Circuit ${index + 1}`,
    external_id: ids.device,
    features: [
      {
        name: 'Flow temperature',
        external_id: ids.feature(FEATURE.FLOW_TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Flow setpoint',
        external_id: ids.feature(FEATURE.FLOW_SETPOINT),
        category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'State',
        external_id: ids.feature(FEATURE.STATE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // No numeric range on a text feature, but `min`/`max` are NOT NULL in
        // the Gladys schema: 0/0 is the "not applicable" encoding.
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
      [ids.feature(FEATURE.FLOW_TEMPERATURE), round1(state.currentCircuitFlowTemperature)],
      [ids.feature(FEATURE.FLOW_SETPOINT), round1(state.heatingCircuitFlowSetpoint)],
    ]),
    ...textStates([[ids.feature(FEATURE.STATE), state.circuitState ?? null]]),
  ];

  return { externalId: ids.device, device, states, commands: {} };
}

export { DEVICE_TYPE as CIRCUIT_DEVICE_TYPE, FEATURE as CIRCUIT_FEATURES };
