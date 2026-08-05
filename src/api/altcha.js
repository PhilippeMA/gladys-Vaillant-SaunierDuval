// -----------------------------------------------------------------------------
// ALTCHA proof-of-work solver.
//
// The Vaillant Group login page is protected by ALTCHA, a self-hosted anti-bot
// widget. Before accepting the credentials, Keycloak asks the browser to solve
// a small proof of work: find the counter `n` such that
//
//     PBKDF2(nonce || uint32be(n), salt, cost) starts with `keyPrefix`
//
// The widget then posts the challenge AND its solution back, base64-encoded, in
// an `altcha` form field. We reproduce exactly that here — it is not a bypass:
// we do the work the browser would do.
//
// `keyPrefix` is one byte in practice, so the expected number of PBKDF2
// derivations is ~256 — a fraction of a second. The loop is asynchronous so it
// never blocks the event loop, and a hard cap keeps a server-side change from
// spinning forever.
// -----------------------------------------------------------------------------

import { pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** Beyond this many attempts we consider the challenge unsolvable. */
const MAX_ATTEMPTS = 500_000;

/** ALTCHA algorithm names mapped to Node digest names. */
const DIGESTS = {
  'PBKDF2/SHA-256': 'sha256',
  'PBKDF2/SHA-384': 'sha384',
  'PBKDF2/SHA-512': 'sha512',
};

/**
 * Solve an ALTCHA challenge and package it the way the browser widget does.
 * @param {object} challenge - Body of GET /api/altcha/challenge.
 * @param {object} challenge.parameters - Algorithm, cost, nonce, salt, keyPrefix.
 * @param {string} challenge.signature - Server signature, echoed back untouched.
 * @returns {Promise<string>} The base64 payload to send as the `altcha` form field.
 */
export async function solveAltchaChallenge(challenge) {
  const { parameters, signature } = challenge;
  const digest = DIGESTS[parameters.algorithm] ?? 'sha256';
  const keyLength = parameters.keyLength ?? 32;
  const nonce = Buffer.from(parameters.nonce, 'hex');
  const salt = Buffer.from(parameters.salt, 'hex');
  const keyPrefix = Buffer.from(parameters.keyPrefix, 'hex');

  for (let counter = 0; counter < MAX_ATTEMPTS; counter += 1) {
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE(counter);
    const password = Buffer.concat([nonce, suffix]);
    // Awaiting the async binding yields to the event loop between attempts.
    const derived = await pbkdf2Async(password, salt, parameters.cost, keyLength, digest);

    if (derived.subarray(0, keyPrefix.length).equals(keyPrefix)) {
      const payload = {
        challenge: { parameters, signature },
        solution: { counter, derivedKey: derived.toString('hex'), time: 0 },
      };
      return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    }
  }

  throw new Error(`ALTCHA challenge unsolved after ${MAX_ATTEMPTS} attempts`);
}
