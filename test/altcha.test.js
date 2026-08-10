// -----------------------------------------------------------------------------
// The login page will not accept credentials without a valid proof of work,
// so a broken solver means "cannot log in at all" — with an error that looks
// like wrong credentials. These tests check the solution really verifies.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { solveAltchaChallenge } from '../src/saunierDuval/altcha.js';

/** A challenge shaped like the one the Vaillant Group login page serves. */
function makeChallenge({ algorithm = 'PBKDF2/SHA-256', cost = 200, keyPrefix = '00' } = {}) {
  return {
    parameters: {
      algorithm,
      cost,
      keyLength: 32,
      keyPrefix,
      nonce: randomBytes(16).toString('hex'),
      salt: randomBytes(16).toString('hex'),
    },
    signature: 'signature-of-the-server',
  };
}

function decode(payload) {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

test('the solved payload carries a counter whose derivation matches the prefix', async () => {
  const challenge = makeChallenge();
  const solved = decode(await solveAltchaChallenge(challenge));

  const { nonce, salt, cost, keyLength, keyPrefix } = challenge.parameters;
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(solved.solution.counter);
  const derived = pbkdf2Sync(
    Buffer.concat([Buffer.from(nonce, 'hex'), suffix]),
    Buffer.from(salt, 'hex'),
    cost,
    keyLength,
    'sha256',
  );

  assert.equal(derived.toString('hex'), solved.solution.derivedKey);
  assert.ok(derived.toString('hex').startsWith(keyPrefix));
});

test('the challenge is echoed back untouched, signature included', async () => {
  const challenge = makeChallenge();
  const solved = decode(await solveAltchaChallenge(challenge));

  // The server verifies its own signature against the parameters it sent:
  // altering either of them invalidates the whole login attempt.
  assert.deepEqual(solved.challenge.parameters, challenge.parameters);
  assert.equal(solved.challenge.signature, challenge.signature);
});

test('the SHA-512 variant of the challenge is honoured', async () => {
  const challenge = makeChallenge({ algorithm: 'PBKDF2/SHA-512' });
  const solved = decode(await solveAltchaChallenge(challenge));

  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(solved.solution.counter);
  const derived = pbkdf2Sync(
    Buffer.concat([Buffer.from(challenge.parameters.nonce, 'hex'), suffix]),
    Buffer.from(challenge.parameters.salt, 'hex'),
    challenge.parameters.cost,
    challenge.parameters.keyLength,
    'sha512',
  );
  assert.equal(derived.toString('hex'), solved.solution.derivedKey);
});

test('a malformed challenge fails loudly instead of silently returning nothing', async () => {
  await assert.rejects(() => solveAltchaChallenge({}), /Malformed ALTCHA challenge/);
});
