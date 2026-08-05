// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a template with a fixed device list, the devices here are DISCOVERED:
// the account may hold several installations, and each installation several
// heating zones. So the registry does not enumerate devices — it enumerates
// device *types* and knows how to:
//   - build the discovery payload from a snapshot of the cloud account;
//   - route an incoming poll or command back to the right system and zone,
//     by reading the external id Gladys sends back.
//
// Each blueprint exposes the same shape:
//   - type                              : device type namespace of its external ids
//   - buildDevice(gladys, context)      : the discovery payload of ONE device
//   - onPoll(gladys, context)           : periodic read
//   - onSetValue(gladys, context)       : run a user command (thermostat only)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { thermostat } from './thermostat.js';
import { boiler } from './boiler.js';
import { parseDeviceExternalId, parseFeatureKey } from './externalIds.js';

const logger = createLogger({ name: 'devices' });

export const DEVICE_BLUEPRINTS = [thermostat, boiler];

/**
 * Build the discovery payload of the whole account: one boiler per
 * installation, one thermostat per active heating zone.
 * @param {object} gladys - The SDK instance.
 * @param {object} context - Discovery context.
 * @param {object} context.client - The API client.
 * @param {object} context.config - Normalized configuration.
 * @returns {Promise<Array<object>>} The discovered devices.
 */
export async function buildDiscoveredDevices(gladys, { client, config }) {
  // Discovery must reflect the account as it is now, not a cached view.
  const systems = await client.getSystems({ force: true });
  const devices = [];

  for (const system of systems) {
    devices.push(boiler.buildDevice(gladys, { system, config }));

    for (const zone of system.zones) {
      // The controllers always expose their maximum number of zones; the ones
      // that are not wired up report no usable value.
      if (!zone.isActive) {
        logger.debug(`Skipping inactive zone ${zone.index} of system ${system.id}`);
        continue;
      }
      devices.push(thermostat.buildDevice(gladys, { system, zone, config }));
    }
  }

  logger.info(`Discovered ${devices.length} device(s) across ${systems.length} installation(s)`);
  return devices;
}

/**
 * Refresh every device of the account in one pass.
 *
 * This is the integration's own polling: Gladys only accepts a closed set of
 * poll intervals capped at one minute, which is far more often than a cloud
 * refreshed every few minutes deserves, so the devices declare no
 * `poll_frequency` and index.js calls this on a timer instead. Publishing a
 * state for a device the user has not created yet is harmless — Gladys
 * silently ignores an unknown feature id.
 * @param {object} gladys - The SDK instance.
 * @param {object} context - Refresh context.
 * @param {object} context.client - The API client.
 * @param {object} context.config - Normalized configuration.
 */
export async function refreshAllDevices(gladys, { client, config }) {
  // One forced read fills the snapshot cache; the per-device polls below then
  // reuse it instead of calling the API again.
  const systems = await client.getSystems({ force: true });

  for (const system of systems) {
    await boiler.onPoll(gladys, { client, config, systemId: system.id });

    for (const zone of system.zones) {
      if (!zone.isActive) {
        continue;
      }
      await thermostat.onPoll(gladys, {
        client,
        config,
        systemId: system.id,
        zoneIndex: zone.index,
      });
    }
  }
}

/**
 * Find the blueprint owning a device type.
 * @param {string} type - Device type namespace.
 * @returns {object|undefined} The blueprint.
 */
export function findBlueprint(type) {
  return DEVICE_BLUEPRINTS.find((blueprint) => blueprint.type === type);
}

/**
 * Resolve the blueprint and the platform coordinates of an incoming device.
 * @param {object} device - The device sent by Gladys.
 * @returns {{blueprint: object, systemId: string, zoneIndex: number|undefined}} The route.
 */
export function routeDevice(device) {
  const parsed = parseDeviceExternalId(device?.external_id);
  const blueprint = parsed ? findBlueprint(parsed.type) : undefined;
  if (!parsed || !blueprint) {
    throw new Error(`Unknown device external_id "${device?.external_id}"`);
  }
  return { blueprint, systemId: parsed.systemId, zoneIndex: parsed.zoneIndex };
}

/**
 * Refresh one device.
 * @param {object} gladys - The SDK instance.
 * @param {object} device - The device to poll.
 * @param {object} context - Poll context.
 * @param {object} context.client - The API client.
 * @param {object} context.config - Normalized configuration.
 */
export async function pollDevice(gladys, device, { client, config }) {
  const { blueprint, systemId, zoneIndex } = routeDevice(device);
  await blueprint.onPoll(gladys, { client, config, systemId, zoneIndex });
}

/**
 * Run a user command on one device feature.
 * @param {object} gladys - The SDK instance.
 * @param {object} command - The command sent by Gladys.
 * @param {object} command.device - The target device.
 * @param {object} command.feature - The target feature.
 * @param {number} command.value - The requested value.
 * @param {object} context - Command context.
 * @param {object} context.client - The API client.
 * @param {object} context.config - Normalized configuration.
 */
export async function setDeviceValue(gladys, { device, feature, value }, { client, config }) {
  const { blueprint, systemId, zoneIndex } = routeDevice(device);
  if (typeof blueprint.onSetValue !== 'function') {
    throw new Error(`Device "${device.external_id}" is read only`);
  }

  const featureKey = parseFeatureKey(feature?.external_id);
  if (!featureKey) {
    throw new Error(`Unknown feature external_id "${feature?.external_id}"`);
  }

  await blueprint.onSetValue(gladys, {
    client,
    config,
    systemId,
    zoneIndex,
    featureKey,
    featureExternalId: feature.external_id,
    value,
  });
}
