// -----------------------------------------------------------------------------
// A SaunierDuvalClient whose HTTP layer is replaced by the fixtures, so the
// tests exercise the real normalization and the real command routing without
// touching the network or the login flow.
// -----------------------------------------------------------------------------

import { SaunierDuvalClient } from '../../src/api/client.js';
import { buildRawSystem, HOME, SYSTEM_ID } from './fixtures.js';

/**
 * Build a client backed by fixtures.
 * @param {object} [options] - Stub options.
 * @param {object} [options.raw] - Raw system payload to serve.
 * @param {string} [options.controlIdentifier] - Controller family to report.
 * @returns {{client: SaunierDuvalClient, calls: Array<object>}} The client and the recorded calls.
 */
export function buildStubbedClient({ raw = buildRawSystem(), controlIdentifier = 'tli' } = {}) {
  const client = new SaunierDuvalClient({
    username: 'user@example.com',
    password: 'secret',
    country: 'france',
    cacheTtl: 30,
  });

  const calls = [];
  client.request = async (url, { method = 'GET', body } = {}) => {
    calls.push({ url, method, body });

    if (url.includes('/meta-info/control-identifier')) {
      return { controlIdentifier };
    }
    if (url.endsWith('/homes')) {
      return [HOME];
    }
    if (url.endsWith(`/systems/${SYSTEM_ID}/tli`) || url.endsWith(`/systems/${SYSTEM_ID}`)) {
      return raw;
    }
    // Commands answer with an empty body.
    return null;
  };

  return { client, calls };
}

/**
 * Keep only the write calls (the commands sent to the API).
 * @param {Array<object>} calls - Recorded calls.
 * @returns {Array<object>} The non-GET calls.
 */
export function writeCalls(calls) {
  return calls.filter((call) => call.method !== 'GET');
}
