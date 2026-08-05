// -----------------------------------------------------------------------------
// The cookie jar. Node's fetch stores nothing, and the Keycloak login POST is
// only accepted if it carries back the session cookies opened by the
// authorization request — so losing a cookie here means "login failed" with no
// other symptom.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/api/cookieJar.js';

/**
 * Build a Response carrying the given Set-Cookie headers.
 * @param {string[]} cookies - Raw Set-Cookie header values.
 * @returns {Response} The response.
 */
function responseWith(cookies) {
  const headers = new Headers();
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { headers });
}

test('every Set-Cookie header of a response is stored', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(
    responseWith([
      'AUTH_SESSION_ID=abc; Path=/auth/realms/sdbg-france-b2c; HttpOnly',
      'KC_RESTART=eyJhbGciOi; Path=/auth; Secure; HttpOnly',
    ]),
  );

  const header = jar.toHeader();
  assert.match(header, /AUTH_SESSION_ID=abc/);
  assert.match(header, /KC_RESTART=eyJhbGciOi/);
});

test('a cookie set again replaces the previous value', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(responseWith(['AUTH_SESSION_ID=first; Path=/']));
  jar.storeFromResponse(responseWith(['AUTH_SESSION_ID=second; Path=/']));

  assert.equal(jar.toHeader(), 'AUTH_SESSION_ID=second');
});

test('a value containing "=" is kept whole', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(responseWith(['KC_RESTART=eyJhbGciOiJIUzI1NiJ9.abc==; Path=/']));

  assert.equal(jar.toHeader(), 'KC_RESTART=eyJhbGciOiJIUzI1NiJ9.abc==');
});

test('cookies the server deletes are dropped', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(responseWith(['KC_RESTART=value; Path=/', 'OTHER=keep; Path=/']));

  jar.storeFromResponse(responseWith(['KC_RESTART=; Path=/; Max-Age=0']));
  assert.equal(jar.toHeader(), 'OTHER=keep');
});

test('a cookie with a past expiry is dropped', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(responseWith(['SESSION=value; Path=/']));
  jar.storeFromResponse(
    responseWith(['SESSION=value; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
  );

  assert.equal(jar.toHeader(), '');
});

test('a cookie with a future expiry is kept', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(
    responseWith(['SESSION=value; Path=/; Expires=Tue, 01 Jan 2099 00:00:00 GMT']),
  );

  assert.equal(jar.toHeader(), 'SESSION=value');
});

test('an empty jar sends no header', () => {
  assert.equal(new CookieJar().toHeader(), '');
});

test('a malformed Set-Cookie header is ignored rather than stored', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(responseWith(['not-a-cookie', '=novalue; Path=/']));

  assert.equal(jar.toHeader(), '');
});
