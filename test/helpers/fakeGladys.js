// -----------------------------------------------------------------------------
// The Gladys the tests run against: the fake one shipped with the SDK.
//
// It is a REAL GladysIntegration — same methods, same argument checks — over
// an in-memory Gladys that validates what it receives like the host API does:
// a discovery list or a state the real Gladys would refuse is refused here
// too, with the same 400. A hand-written stand-in accepted anything, which is
// how a `poll_frequency` in seconds once reached production.
//
// External ids therefore carry the real prefix, `ext:<selector>:`. `id()`
// builds one, so the tests read `id('zone:system-1-0:mode')`.
// -----------------------------------------------------------------------------

import { createFakeGladys as createSdkFakeGladys } from '@gladysassistant/integration-sdk/testing';

export const SELECTOR = 'test-integration';

/** External id of a device or a feature, as Gladys knows it. */
export const id = (suffix) => `ext:${SELECTOR}:${suffix}`;

export function createFakeGladys(options = {}) {
  return createSdkFakeGladys({ selector: SELECTOR, ...options });
}
