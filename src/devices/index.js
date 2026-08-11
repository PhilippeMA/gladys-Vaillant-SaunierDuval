// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a fixed catalog of demo devices, the devices of this integration are
// DISCOVERED: an installation may have one zone or four, a hot water tank or
// none, one direct circuit or several mixed ones. So there is no static list
// here — one snapshot of the boiler is turned into a list of "device models",
// and everything else (discovery payload, states to publish, command routing)
// is read from those models.
//
// A device model is:
//   {
//     externalId,        // external_id of the device
//     device,            // discovery payload sent to Gladys
//     states,            // states to publish for the current snapshot
//     commands,          // featureExternalId -> (client, value) => Promise
//   }
//
// NOTE — no `poll_frequency` on the published devices, on purpose. The Gladys
// core only accepts the fixed frequencies of DEVICE_POLL_FREQUENCIES (1 s to
// 1 min, expressed in MILLISECONDS), and rejects the WHOLE discovery payload
// otherwise. A boiler is read every few minutes, which that list cannot even
// express, so the integration drives its own refresh loop (see index.js) and
// pushes the states. Gladys-driven polling stays supported if a user enables
// it by hand on a device: `onPoll` is still wired, and served from the same
// cached snapshot.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { dhwSection } from '../saunierDuval/client.js';
import { buildCircuitDevice } from './circuit.js';
import { buildDomesticHotWaterDevice } from './domesticHotWater.js';
import { seedOverrideMinutes } from './overrideDuration.js';
import { buildSystemDevice } from './system.js';
import { ZONE_FEATURES, buildZoneDevice } from './zone.js';

const logger = createLogger({ name: 'devices' });

/**
 * Turn a snapshot of the account into the list of device models.
 *
 * @param {object} gladys the SDK instance
 * @param {Array} snapshot as returned by `SaunierDuvalClient.getSnapshot()`
 * @param {object} config the integration configuration
 * @returns {Array} device models
 */
export function buildDeviceModels(gladys, snapshot, config) {
  const models = [];

  for (const entry of snapshot ?? []) {
    models.push(buildSystemDevice(gladys, entry));

    // A zone declared inactive in the boiler is a zone the installer did not
    // wire: it reports nothing, so it would only add a dead device in Gladys.
    const zones = entry.system?.properties?.zones ?? [];
    for (const zone of zones) {
      if (zone.isActive === false) {
        logger.debug(`Zone ${zone.index} of ${entry.systemId} is inactive, skipped`);
        continue;
      }
      models.push(buildZoneDevice(gladys, entry, zone.index, config));
    }

    for (const circuit of entry.system?.state?.circuits ?? []) {
      models.push(buildCircuitDevice(gladys, entry, circuit.index));
    }

    for (const dhw of dhwSection(entry.system?.state)) {
      models.push(buildDomesticHotWaterDevice(gladys, entry, dhw.index));
    }
  }

  logger.debug(`${models.length} device(s) built from ${(snapshot ?? []).length} system(s)`);
  return models;
}

/** Discovery payload of every device. */
export function toDiscoveredDevices(models) {
  return models.map((model) => model.device);
}

/**
 * Restore the override durations from the devices Gladys already holds.
 *
 * The duration a user picked is a setting of the integration, not a register
 * of the boiler, so a restarted container would otherwise fall back to the
 * configured default while the interface still displayed the chosen value.
 * Gladys keeps the last value of the feature, so we read it back from there.
 *
 * @param {Array} devices as returned by `gladys.getDevices()`
 * @returns {number} how many durations were restored
 */
export function seedOverrideDurationsFromDevices(devices) {
  let restored = 0;
  for (const device of devices ?? []) {
    for (const feature of device.features ?? []) {
      if (!feature.external_id?.endsWith(`:${ZONE_FEATURES.OVERRIDE_DURATION}`)) {
        continue;
      }
      if (Number.isFinite(Number(feature.last_value))) {
        seedOverrideMinutes(device.external_id, feature.last_value);
        restored += 1;
      }
    }
  }
  return restored;
}

/** States of every device. */
export function toStates(models) {
  return models.flatMap((model) => model.states);
}

/** Maximum number of states the host API accepts in one batch. */
export const MAX_STATES_PER_BATCH = 100;

/**
 * Split states into batches the host API accepts. A single boiler stays well
 * under the limit, but an account with several installations and many zones
 * would silently lose the overflow otherwise.
 */
export function toStateBatches(states) {
  const batches = [];
  for (let i = 0; i < states.length; i += MAX_STATES_PER_BATCH) {
    batches.push(states.slice(i, i + MAX_STATES_PER_BATCH));
  }
  return batches;
}

/** States of ONE device, when Gladys polls it individually. */
export function statesOfDevice(models, deviceExternalId) {
  const model = models.find((candidate) => candidate.externalId === deviceExternalId);
  return model ? model.states : [];
}

/**
 * Find the command handler of a controllable feature.
 * @returns {Function|null} `(client, value) => Promise`
 */
export function findCommand(models, featureExternalId) {
  for (const model of models) {
    const command = model.commands[featureExternalId];
    if (command) {
      return command;
    }
  }
  return null;
}
