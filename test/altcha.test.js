// -----------------------------------------------------------------------------
// The ALTCHA proof of work guarding the login page. The test does not hard-code
// an expected counter — it checks the property the server checks: the returned
// solution really is a preimage whose derived key starts with the requested
// prefix.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { solveAltchaChallenge } from '../src/api/altcha.js';

/** A cheap challenge: the real one costs 5000 iterations, we only need shape. */
const PARAMETERS = {
  algorithm: 'PBKDF2/SHA-256',
  cost: 10,
  keyLength: 32,
  keyPrefix: '00',
  nonce: 'a1b2c3d4',
  salt: 'deadbeef',
};

const CHALLENGE = { parameters: PARAMETERS, signature: 'server-signature' };

/**
 * Decode the base64 payload the solver produces.
 * @param {string} payload - The `altcha` form value.
 * @returns {object} The decoded payload.
 */
function decode(payload) {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

test('the solution is a valid preimage for the requested prefix', async () => {
  const { solution } = decode(await solveAltchaChallenge(CHALLENGE));

  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(solution.counter);
  const derived = pbkdf2Sync(
    Buffer.concat([Buffer.from(PARAMETERS.nonce, 'hex'), suffix]),
    Buffer.from(PARAMETERS.salt, 'hex'),
    PARAMETERS.cost,
    PARAMETERS.keyLength,
    'sha256',
  );

  assert.equal(derived.toString('hex'), solution.derivedKey);
  assert.ok(derived.toString('hex').startsWith(PARAMETERS.keyPrefix));
});

test('the challenge and its signature are echoed back untouched', async () => {
  const payload = decode(await solveAltchaChallenge(CHALLENGE));
  assert.deepEqual(payload.challenge, CHALLENGE);
});

test('the solver honours the algorithm the server asked for', async () => {
  const parameters = { ...PARAMETERS, algorithm: 'PBKDF2/SHA-512', keyLength: 64 };
  const { solution } = decode(await solveAltchaChallenge({ parameters, signature: 'sig' }));

  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(solution.counter);
  const derived = pbkdf2Sync(
    Buffer.concat([Buffer.from(parameters.nonce, 'hex'), suffix]),
    Buffer.from(parameters.salt, 'hex'),
    parameters.cost,
    parameters.keyLength,
    'sha512',
  );

  assert.equal(derived.toString('hex'), solution.derivedKey);
});
