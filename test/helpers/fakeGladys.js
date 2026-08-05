// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
// This lets us test the wiring (discovery payloads, routing, published states)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

/** Selector used to build external ids, mirroring a real integration. */
export const SELECTOR = 'saunier-duval';

/**
 * Build a fake SDK instance.
 * @returns {object} The fake, with a `published` array of the states it received.
 */
export function createFakeGladys() {
  const published = [];

  return {
    published,

    externalIds(type, platformId) {
      const device = `ext:${SELECTOR}:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
        });
      }
    },

    /**
     * Value published for a feature, or undefined.
     * @param {string} featureExternalId - The feature external id.
     * @returns {number|undefined} The last published state.
     */
    stateOf(featureExternalId) {
      return published.findLast((entry) => entry.featureExternalId === featureExternalId)?.state;
    },
  };
}
