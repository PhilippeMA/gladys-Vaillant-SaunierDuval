// -----------------------------------------------------------------------------
// External identifiers of the devices this integration creates.
//
// Gladys routes every command and every poll by `external_id`, so the ids must
// be unique, stable across restarts, and — since our devices are discovered at
// runtime rather than hard-coded — parseable back into "which system, which
// zone". They are always built through `gladys.externalIds()`, which prefixes
// them with `ext:<selector>:` as the server requires.
//
//   thermostat -> ext:<selector>:thermostat:<systemId>_z<zoneIndex>
//   boiler     -> ext:<selector>:boiler:<systemId>
//
// The system id is the opaque identifier the cloud gives the installation, and
// the zone index its position in the controller: both come from the platform
// and never from a label the user could rename.
// -----------------------------------------------------------------------------

export const DEVICE_TYPES = {
  THERMOSTAT: 'thermostat',
  BOILER: 'boiler',
};

/**
 * Platform id of the thermostat of one heating zone.
 * @param {string} systemId - System identifier.
 * @param {number} zoneIndex - Zone index.
 * @returns {string} The platform id.
 */
export function thermostatPlatformId(systemId, zoneIndex) {
  return `${systemId}_z${zoneIndex}`;
}

/**
 * External ids of the thermostat of one heating zone.
 * @param {object} gladys - The SDK instance.
 * @param {string} systemId - System identifier.
 * @param {number} zoneIndex - Zone index.
 * @returns {{device: string, feature: Function}} The external ids.
 */
export function thermostatIds(gladys, systemId, zoneIndex) {
  return gladys.externalIds(DEVICE_TYPES.THERMOSTAT, thermostatPlatformId(systemId, zoneIndex));
}

/**
 * External ids of the boiler of one system.
 * @param {object} gladys - The SDK instance.
 * @param {string} systemId - System identifier.
 * @returns {{device: string, feature: Function}} The external ids.
 */
export function boilerIds(gladys, systemId) {
  return gladys.externalIds(DEVICE_TYPES.BOILER, systemId);
}

/**
 * Read back which system and zone a device external id designates.
 * @param {string} externalId - The device external id.
 * @returns {{type: string, systemId: string, zoneIndex?: number}|null} The parts, or null when unknown.
 */
export function parseDeviceExternalId(externalId) {
  const parts = String(externalId ?? '').split(':');
  // ext : <selector> : <type> : <platformId>
  if (parts.length < 4 || parts[0] !== 'ext') {
    return null;
  }
  const type = parts[2];
  const platformId = parts.slice(3).join(':');

  if (type === DEVICE_TYPES.BOILER) {
    return platformId ? { type, systemId: platformId } : null;
  }
  if (type === DEVICE_TYPES.THERMOSTAT) {
    const match = platformId.match(/^(.+)_z(\d+)$/);
    return match ? { type, systemId: match[1], zoneIndex: Number(match[2]) } : null;
  }
  return null;
}

/**
 * Read back which feature a feature external id designates.
 * @param {string} externalId - The feature external id.
 * @returns {string|null} The feature key, or null.
 */
export function parseFeatureKey(externalId) {
  const parts = String(externalId ?? '').split(':');
  return parts.length >= 5 ? parts[parts.length - 1] : null;
}
