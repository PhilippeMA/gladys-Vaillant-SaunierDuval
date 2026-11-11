// -----------------------------------------------------------------------------
// The whole integration, started for a test: the real `createApp` on the fake
// Gladys of the SDK, with a client answering from the fixtures.
// -----------------------------------------------------------------------------

import { createApp } from '../../src/app.js';
import { resetOverrideDurations } from '../../src/devices/overrideDuration.js';
import { createFakeGladys } from './fakeGladys.js';
import { tliSnapshotEntry } from './fixtures.js';
import { createStubClient } from './stubClient.js';

export const CREDENTIALS = { email: 'user@example.com', password: 's3cret' };

/**
 * Start the integration and connect it.
 *
 * @param {object} [options]
 * @param {Array} [options.entries] the installations of the account
 * @param {object} [options.config] the configuration filled in by the user
 * @param {Array} [options.devices] the devices already created in Gladys
 * @returns the fake Gladys, the stubbed client and the entries (editable)
 */
export async function startApp({
  entries = [tliSnapshotEntry()],
  config = CREDENTIALS,
  devices = [],
} = {}) {
  // The override durations live at module level: one test must not leak its
  // choices into the next.
  resetOverrideDurations();

  const stub = createStubClient(entries);
  const gladys = createFakeGladys({ config, devices });
  // No delay on the read-back after a command: `app.settle()` awaits it.
  const app = createApp(gladys, { createClient: () => stub.client, confirmDelayMs: 0 });
  await gladys.connect();

  return {
    gladys,
    app,
    entries,
    ...stub,
    /** Find a discovered device by the end of its external id. */
    device: (suffix) =>
      gladys.fake.discoveredDevices.find((device) => device.external_id.endsWith(suffix)),
    /** Find a feature of a discovered device. */
    feature(deviceSuffix, featureKey) {
      return this.device(deviceSuffix).features.find((feature) =>
        feature.external_id.endsWith(`:${featureKey}`),
      );
    },
    /** A new reading of everything, metadata included, like a "scan". */
    async readAgain() {
      await gladys.fake.scanRequest();
    },
    async stop() {
      await app.settle();
      await gladys.disconnect();
    },
  };
}
