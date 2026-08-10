// -----------------------------------------------------------------------------
// How many HTTP requests a refresh cycle costs.
//
// The Saunier Duval platform is rate limited and shared with the mobile
// application, so the number of calls is a feature, not an implementation
// detail. One system payload carries every value the integration publishes;
// everything else is metadata that does not move at the rhythm of a
// temperature. These tests pin that budget down.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaunierDuvalClient } from '../src/saunierDuval/client.js';
import { tliSnapshotEntry } from './helpers/fixtures.js';

/** Thirty-one minutes: just past the metadata TTL of the client. */
const PAST_THE_METADATA_TTL_MS = 31 * 60 * 1000;

/**
 * A client whose HTTP layer answers from the fixtures and records every call,
 * so a test can count the round trips a cycle really costs.
 */
function countingClient() {
  const client = new SaunierDuvalClient({
    email: 'user@example.com',
    password: 's3cret',
    country: 'france',
  });
  const entry = tliSnapshotEntry();
  const calls = [];

  client.request = async (method, url) => {
    calls.push(url);
    if (url.endsWith('/homes')) {
      return [{ ...entry.home, onlineState: 'ONLINE' }];
    }
    if (url.endsWith('/meta-info/control-identifier')) {
      return { controlIdentifier: 'tli' };
    }
    if (url.endsWith('/diagnostic-trouble-codes')) {
      return entry.troubleCodes;
    }
    if (url.endsWith(`/systems/${entry.systemId}/tli`)) {
      return entry.system;
    }
    throw new Error(`unexpected call: ${method} ${url}`);
  };

  /** Calls made since the last checkpoint. */
  const since = (mark) => calls.slice(mark);
  return { client, calls, since };
}

/** Force a fresh read of the boiler, like one tick of the refresh loop. */
const cycle = (client) => client.getSnapshot({ maxAgeMs: 0 });

test('a warm refresh cycle costs ONE request per installation', async () => {
  const { client, calls, since } = countingClient();

  await cycle(client); // first cycle: everything is cold
  const afterWarmUp = calls.length;

  await cycle(client);
  await cycle(client);

  const warmCalls = since(afterWarmUp);
  assert.equal(warmCalls.length, 2, `expected 1 call per cycle, got: ${warmCalls.join(', ')}`);
  for (const url of warmCalls) {
    assert.ok(url.endsWith('/tli'), `a warm cycle must only read the system payload, got ${url}`);
  }
});

test('the first cycle reads the metadata once, and only once', async () => {
  const { client, calls } = countingClient();

  await cycle(client);

  assert.deepEqual(calls.filter((url) => url.endsWith('/homes')).length, 1);
  assert.deepEqual(calls.filter((url) => url.endsWith('/meta-info/control-identifier')).length, 1);
  assert.deepEqual(calls.filter((url) => url.endsWith('/diagnostic-trouble-codes')).length, 1);
  assert.equal(calls.length, 4);
});

test('the connection status is read from the installations, not from its own endpoint', async () => {
  const { client, calls } = countingClient();

  const snapshot = await cycle(client);

  // It used to be one dedicated request per cycle, for a value the homes
  // payload already carries.
  assert.ok(!calls.some((url) => url.includes('connection-status')));
  assert.equal(snapshot[0].online, true);
});

test('an offline gateway is reported from the same payload', async () => {
  const { client } = countingClient();
  client.request = async () => [{ systemId: 'system-1', onlineState: 'OFFLINE' }];
  // Only the homes call matters here; the rest would fail, so read it directly.
  const homes = await client.getHomes();
  assert.equal(homes[0].onlineState, 'OFFLINE');
});

test('the metadata is read again once its cache expires', async () => {
  const { client, calls, since } = countingClient();

  await cycle(client);
  const afterWarmUp = calls.length;

  // Age the metadata past its TTL, as the passing hours would.
  client.homesCache.fetchedAt -= PAST_THE_METADATA_TTL_MS;
  for (const cached of client.troubleCodesCache.values()) {
    cached.fetchedAt -= PAST_THE_METADATA_TTL_MS;
  }

  await cycle(client);

  const refreshed = since(afterWarmUp);
  assert.ok(refreshed.some((url) => url.endsWith('/homes')));
  assert.ok(refreshed.some((url) => url.endsWith('/diagnostic-trouble-codes')));
  // The controller family is not re-read: it cannot change on a live boiler.
  assert.ok(!refreshed.some((url) => url.endsWith('/meta-info/control-identifier')));
});

test('a forced read drops the metadata cache: a scan sees a new zone', async () => {
  const { client, calls, since } = countingClient();

  await cycle(client);
  const afterWarmUp = calls.length;

  await client.getSnapshot({ force: true });

  const forced = since(afterWarmUp);
  assert.ok(forced.some((url) => url.endsWith('/homes')));
  assert.ok(forced.some((url) => url.endsWith('/diagnostic-trouble-codes')));
});

test('everything happening inside one cycle shares a single read', async () => {
  const { client, calls } = countingClient();

  await cycle(client);
  const afterWarmUp = calls.length;

  // A device Gladys polls itself, then a command looking up its handler: both
  // land within the cycle window and must not re-read the boiler.
  const maxAgeMs = 150_000;
  await Promise.all([
    client.getSnapshot({ maxAgeMs }),
    client.getSnapshot({ maxAgeMs }),
    client.getSnapshot({ maxAgeMs }),
  ]);

  assert.equal(calls.length, afterWarmUp, 'a cached snapshot must cost nothing');
});

test('concurrent cold reads are collapsed into one round trip', async () => {
  const { client, calls } = countingClient();

  // Several devices polled at the same instant, cache empty: the in-flight
  // request is shared instead of hitting the platform once per caller.
  await Promise.all([cycle(client), cycle(client), cycle(client)]);

  assert.equal(calls.filter((url) => url.endsWith('/tli')).length, 1);
});
