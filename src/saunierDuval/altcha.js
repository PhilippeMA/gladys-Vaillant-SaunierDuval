// -----------------------------------------------------------------------------
// ALTCHA proof-of-work solver.
//
// Before accepting credentials, the Vaillant Group login page asks the browser
// to solve a small proof of work: find the counter whose PBKDF2 derivation
// starts with a given prefix. The widget then posts the solution back as the
// `altcha` form field. We do exactly the same, from Node.
//
// The cost is deliberately low (a fraction of a second): it only runs when a
// new session has to be opened, i.e. rarely.
// -----------------------------------------------------------------------------

import { pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** Digest to use for each algorithm advertised by the challenge. */
const DIGESTS = {
  'PBKDF2/SHA-512': 'sha512',
  'PBKDF2/SHA-384': 'sha384',
  'PBKDF2/SHA-256': 'sha256',
};

/**
 * Upper bound on the search. With the usual one-byte prefix the answer is
 * found after ~256 tries; the cap only exists so a malformed challenge cannot
 * spin forever.
 */
const MAX_COUNTER = 1_000_000;

/**
 * Solve a challenge and return the base64 payload expected in the `altcha`
 * login field.
 *
 * @param {{ parameters: Record<string, unknown>, signature: string }} challenge
 *   Body of GET /api/altcha/challenge.
 * @returns {Promise<string>} base64 payload
 */
export async function solveAltchaChallenge(challenge) {
  const parameters = challenge?.parameters;
  if (!parameters) {
    throw new Error('Malformed ALTCHA challenge: missing parameters');
  }

  const nonce = Buffer.from(parameters.nonce, 'hex');
  const salt = Buffer.from(parameters.salt, 'hex');
  const keyPrefix = Buffer.from(parameters.keyPrefix ?? '', 'hex');
  const cost = Number(parameters.cost);
  const keyLength = Number(parameters.keyLength ?? 32);
  const digest = DIGESTS[parameters.algorithm] ?? 'sha256';

  for (let counter = 0; counter < MAX_COUNTER; counter += 1) {
    // The "password" is the nonce followed by the counter, big endian on 4 bytes.
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(counter);
    const derived = await pbkdf2Async(
      Buffer.concat([nonce, suffix]),
      salt,
      cost,
      keyLength,
      digest,
    );

    if (derived.subarray(0, keyPrefix.length).equals(keyPrefix)) {
      const payload = {
        challenge: { parameters, signature: challenge.signature },
        // `time` is informational (how long the widget took): the server only
        // verifies its own signature and the derived key.
        solution: { counter, derivedKey: derived.toString('hex'), time: 0 },
      };
      return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    }
  }

  throw new Error(`Could not solve the ALTCHA challenge in ${MAX_COUNTER} iterations`);
}
