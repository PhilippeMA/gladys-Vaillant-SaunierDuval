// -----------------------------------------------------------------------------
// A real SaunierDuvalClient whose HTTP layer answers from the fixtures.
//
// Everything above the network is the code under test: the tiered cache, the
// URL of each command, the payloads. The entries are served by reference, so a
// test changes the state of the "boiler" between two readings simply by
// editing them, and every call is recorded.
// -----------------------------------------------------------------------------

import { SaunierDuvalClient } from '../../src/saunierDuval/client.js';

/**
 * @param {Array} entries snapshot entries, see fixtures.js
 * @returns {{ client: SaunierDuvalClient, calls: Array, writes: Function }}
 */
export function createStubClient(entries) {
  const client = new SaunierDuvalClient({
    email: 'user@example.com',
    password: 's3cret',
    country: 'france',
  });
  const calls = [];

  client.request = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method !== 'GET') {
      return null;
    }
    if (url.endsWith('/homes')) {
      return entries.map((entry) => ({
        ...entry.home,
        systemId: entry.systemId,
        onlineState: entry.online === false ? 'OFFLINE' : 'ONLINE',
      }));
    }
    const entry = entries.find((candidate) => url.includes(`/systems/${candidate.systemId}`));
    if (!entry) {
      throw new Error(`unexpected call: ${method} ${url}`);
    }
    if (url.endsWith('/meta-info/control-identifier')) {
      return { controlIdentifier: entry.controlIdentifier };
    }
    if (url.endsWith('/diagnostic-trouble-codes')) {
      return entry.troubleCodes;
    }
    return entry.system;
  };

  return {
    client,
    calls,
    /** The calls that changed something on the boiler. */
    writes: () => calls.filter((call) => call.method !== 'GET'),
  };
}
