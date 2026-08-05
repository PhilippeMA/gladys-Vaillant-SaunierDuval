// -----------------------------------------------------------------------------
// The parts of the login flow that depend on what Keycloak sends back: the form
// action scraped from the login page, and the authorization code carried by a
// custom-scheme redirect. These are the pieces a redesign of the login page
// would break, so they are pinned here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractCode, extractLoginUrl, generateCodeChallenge } from '../src/api/auth.js';
import { getRealm } from '../src/api/constants.js';

const REALM = getRealm('france');
const ACTION = `https://identity.vaillant-group.com/auth/realms/${REALM}/login-actions/authenticate?session_code=abc123&execution=def456&client_id=myvaillant&tab_id=xyz`;

test('the realm of a Saunier Duval account is built from its country', () => {
  assert.equal(getRealm('france'), 'sdbg-france-b2c');
  assert.equal(getRealm('spain'), 'sdbg-spain-b2c');
});

test('the login form action is extracted and HTML-unescaped', () => {
  const html = `<form id="kc-form-login" action="${ACTION.replaceAll('&', '&amp;')}" method="post">`;
  assert.equal(extractLoginUrl(html, REALM), ACTION);
});

test('a login page without a form yields no action', () => {
  assert.equal(extractLoginUrl('<html><body>Service unavailable</body></html>', REALM), null);
});

test('a form belonging to another realm is not picked up', () => {
  const html = `<form action="${ACTION}" method="post">`;
  assert.equal(extractLoginUrl(html, getRealm('spain')), null);
});

test('the authorization code is read from the mobile deep link', () => {
  const location = 'enduservaillant.page.link://login?state=xyz&code=the-code&session_state=abc';
  assert.equal(extractCode(location), 'the-code');
});

test('a redirect carrying no code yields none', () => {
  assert.equal(extractCode(null), null);
  assert.equal(extractCode('enduservaillant.page.link://login'), null);
  assert.equal(extractCode('enduservaillant.page.link://login?error=access_denied'), null);
});

test('the PKCE challenge is the S256 hash of its verifier', () => {
  const { codeVerifier, codeChallenge } = generateCodeChallenge();

  assert.equal(codeVerifier.length, 128, 'RFC 7636 allows at most 128 characters');
  assert.match(codeVerifier, /^[A-Za-z0-9_-]+$/, 'the verifier must be base64url');
  assert.equal(codeChallenge, createHash('sha256').update(codeVerifier).digest('base64url'));
});

test('each login starts from a fresh verifier', () => {
  assert.notEqual(generateCodeChallenge().codeVerifier, generateCodeChallenge().codeVerifier);
});
