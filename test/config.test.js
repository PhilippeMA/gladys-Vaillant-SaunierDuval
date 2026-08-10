import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps the user values over the defaults', () => {
  const config = normalizeConfig({
    email: 'user@example.com',
    password: 's3cret',
    country: 'spain',
  });
  assert.equal(config.email, 'user@example.com');
  assert.equal(config.password, 's3cret');
  assert.equal(config.country, 'spain');
});

test('normalizeConfig trims the email, which users paste with a trailing space', () => {
  assert.equal(normalizeConfig({ email: '  user@example.com ' }).email, 'user@example.com');
});

test('normalizeConfig coerces the numbers coming from the form as strings', () => {
  const config = normalizeConfig({ poll_frequency: '600', quick_veto_duration: '1.5' });
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.quick_veto_duration, 1.5);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps the numbers to the range of the manifest', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 60);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ quick_veto_duration: 0 }).quick_veto_duration, 0.5);
  assert.equal(normalizeConfig({ quick_veto_duration: 48 }).quick_veto_duration, 24);
});

test('normalizeConfig falls back to the default for an unreadable number', () => {
  assert.equal(
    normalizeConfig({ poll_frequency: 'often' }).poll_frequency,
    DEFAULT_CONFIG.poll_frequency,
  );
});

test('normalizeConfig refuses a country that has no Saunier Duval realm', () => {
  // A wrong country would silently build an invalid Keycloak realm and every
  // login would fail with an opaque error.
  assert.equal(normalizeConfig({ country: 'atlantis' }).country, DEFAULT_CONFIG.country);
});

test('isConfigured requires both an email and a password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'user@example.com' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 's3cret' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ email: 'user@example.com', password: 's3cret' })),
    true,
  );
});
