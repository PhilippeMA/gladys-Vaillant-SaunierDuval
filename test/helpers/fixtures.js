// -----------------------------------------------------------------------------
// Payloads mirroring what the myVAILLANT API returns for a Saunier Duval
// installation. The shapes (key names, nesting, the 0.0 setpoint of a zone
// asking for no heat) are the ones observed on real accounts.
// -----------------------------------------------------------------------------

export const SYSTEM_ID = '3692f21be10859c90ac96ada644badd442d5f9c2';

/** One entry of GET /homes. */
export const HOME = {
  homeName: 'Maison',
  serialNumber: '0b47906a466bc453826bc0cca27fad88dc08bcb6',
  systemId: SYSTEM_ID,
  productMetadata: { productType: 'MiGo Link', articleNumber: '0020260962' },
  state: 'CLAIMED',
  nomenclature: 'MiGo Link',
  countryCode: 'FR',
};

/**
 * Body of the system endpoint of a `tli` controller.
 * @param {object} [overrides] - Deep overrides, merged one level per block.
 * @returns {object} The raw system payload.
 */
export function buildRawSystem(overrides = {}) {
  return {
    state: {
      system: {
        outdoorTemperature: 4.0585938,
        systemWaterPressure: 1.3,
        outdoorTemperatureAverage24h: 7.375,
        ...overrides.systemState,
      },
      zones: [
        {
          index: 0,
          desiredRoomTemperatureSetpointHeating: 20.0,
          desiredRoomTemperatureSetpoint: 20.0,
          currentRoomTemperature: 21.9125,
          currentRoomHumidity: 42.0,
          currentSpecialFunction: 'NONE',
          heatingState: 'IDLE',
          ...overrides.zoneState,
        },
      ],
      circuits: [
        {
          index: 0,
          circuitState: 'STANDBY',
          currentCircuitFlowTemperature: 21.0,
          ...overrides.circuitState,
        },
      ],
    },
    properties: {
      zones: [{ index: 0, isActive: true, ...overrides.zoneProperties }],
    },
    configuration: {
      zones: [
        {
          index: 0,
          general: { name: 'Salon' },
          heating: {
            operationModeHeating: 'TIME_CONTROLLED',
            setBackTemperature: 18.0,
            manualModeSetpointHeating: 19.0,
            ...overrides.zoneHeating,
          },
        },
      ],
    },
  };
}
