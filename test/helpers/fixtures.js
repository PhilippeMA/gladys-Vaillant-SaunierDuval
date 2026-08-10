// -----------------------------------------------------------------------------
// Snapshot fixtures, shaped exactly like what `SaunierDuvalClient.getSnapshot()`
// returns: the payloads below are trimmed copies of what the Saunier Duval
// platform answers for a real installation.
// -----------------------------------------------------------------------------

/** A MiGo Link installation (tli): one zone, one circuit, one hot water circuit. */
export function tliSnapshotEntry(overrides = {}) {
  return {
    home: { homeName: 'Maison', systemId: 'system-1', nomenclature: 'MiGo Link' },
    systemId: 'system-1',
    controlIdentifier: 'tli',
    connected: true,
    troubleCodes: [{ serialNumber: 'abc', articleNumber: '0010', codes: [] }],
    system: {
      state: {
        system: {
          outdoorTemperature: 8.019531,
          outdoorTemperatureAverage24h: 11.300781,
          systemWaterPressure: 1.3,
          energyManagerState: 'HEATING',
          systemOff: false,
        },
        zones: [
          {
            index: 0,
            desiredRoomTemperatureSetpoint: 20.0,
            desiredRoomTemperatureSetpointHeating: 20.0,
            currentRoomTemperature: 19.2875,
            currentRoomHumidity: 42.0,
            currentSpecialFunction: 'NONE',
          },
        ],
        circuits: [
          {
            index: 0,
            circuitState: 'HEATING',
            currentCircuitFlowTemperature: 46.0,
            heatingCircuitFlowSetpoint: 47.00972,
          },
        ],
        dhw: [{ index: 255, currentSpecialFunction: 'REGULAR', currentDhwTemperature: 43.0 }],
      },
      properties: {
        system: { controllerType: 'MiGo Link' },
        zones: [{ index: 0, isActive: true, associatedCircuitIndex: 0 }],
        circuits: [{ index: 0, heatingCircuitType: 'DIRECT_HEATING_CIRCUIT' }],
        dhw: [{ index: 255, minSetpoint: 35.0, maxSetpoint: 65.0 }],
      },
      configuration: {
        zones: [
          {
            index: 0,
            general: { name: 'Salon' },
            heating: { operationModeHeating: 'TIME_CONTROLLED', manualModeSetpointHeating: 21.0 },
          },
        ],
        circuits: [{ index: 0, heatingCurve: 1.2 }],
        dhw: [{ index: 255, operationModeDhw: 'TIME_CONTROLLED', tappingSetpoint: 55.0 }],
      },
    },
    ...overrides,
  };
}

/**
 * An older MiPro / Exacontrol installation (vrc700). Note the hot water
 * circuits under `domesticHotWater` instead of `dhw`, and the different mode
 * vocabulary (DAY / AUTO / SET_BACK instead of MANUAL / TIME_CONTROLLED).
 */
export function vrc700SnapshotEntry(overrides = {}) {
  return {
    home: { homeName: 'Chalet', systemId: 'system-2', nomenclature: 'MiGo' },
    systemId: 'system-2',
    controlIdentifier: 'vrc700',
    connected: true,
    troubleCodes: [
      {
        serialNumber: 'def',
        articleNumber: '0020',
        codes: [
          {
            code: 'F.28',
            type: 'ERROR',
            title: 'Ignition failure',
            occurrenceTimestamp: '2026-01-02T03:04:05Z',
          },
        ],
      },
    ],
    system: {
      state: {
        system: {
          outdoorTemperature: 6.875,
          outdoorTemperatureAverage24h: 8.957031,
          systemWaterPressure: 2.3,
          energyManagerState: 'DHW',
          systemOff: false,
        },
        zones: [
          {
            index: 0,
            desiredRoomTemperatureSetpoint: 19.5,
            currentRoomTemperature: 19.0625,
            currentSpecialFunction: 'NONE',
          },
        ],
        circuits: [
          {
            index: 0,
            circuitState: 'STANDBY',
            currentCircuitFlowTemperature: 32.5,
            heatingCircuitFlowSetpoint: 32.544678,
          },
        ],
        domesticHotWater: [
          { index: 255, currentSpecialFunction: 'CYLINDER_BOOST', currentDhwTemperature: 51.0 },
        ],
      },
      properties: {
        system: { controllerType: 'VRC700' },
        zones: [{ index: 0, isActive: true, associatedCircuitIndex: 0 }],
        circuits: [{ index: 0 }],
        domesticHotWater: [{ index: 255, minSetpoint: 40.0, maxSetpoint: 70.0 }],
      },
      configuration: {
        zones: [
          {
            index: 0,
            general: { name: 'Séjour' },
            heating: { operationModeHeating: 'AUTO', dayTemperatureHeating: 20.0 },
          },
        ],
        circuits: [{ index: 0 }],
        domesticHotWater: [{ index: 255, operationModeDhw: 'DAY', tappingSetpoint: 60.0 }],
      },
    },
    ...overrides,
  };
}
