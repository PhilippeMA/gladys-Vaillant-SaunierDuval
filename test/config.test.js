// -----------------------------------------------------------------------------
// Configuration normalization: the rest of the code must never see an
// undefined, a string where a number is expected, or a country that would
// build an unknown Keycloak realm.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from '../src/config.js';

test('an empty configuration falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('numbers arriving as strings from the form are coerced', () => {
  const config = normalizeConfig({ poll_frequency: '600', quick_veto_duration: '1.5' });
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.quick_veto_duration, 1.5);
});

test('out-of-range numbers are brought back inside their bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 60);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ quick_veto_duration: 0 }).quick_veto_duration, 0.5);
  assert.equal(normalizeConfig({ quick_veto_duration: 48 }).quick_veto_duration, 24);
});

test('unusable numbers fall back to the default instead of becoming NaN', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'often' }).poll_frequency, 300);
});

test('an unsupported country falls back to the default', () => {
  assert.equal(normalizeConfig({ country: 'germany' }).country, 'france');
  assert.equal(normalizeConfig({ country: 'spain' }).country, 'spain');
});

test('the email address is trimmed', () => {
  assert.equal(normalizeConfig({ username: '  user@example.com ' }).username, 'user@example.com');
});

test('an unknown heating mode falls back to the weekly schedule', () => {
  assert.equal(normalizeConfig({ heating_on_mode: 'BOOST' }).heating_on_mode, 'TIME_CONTROLLED');
  assert.equal(normalizeConfig({ heating_on_mode: 'MANUAL' }).heating_on_mode, 'MANUAL');
});

test('isConfigured requires both an email address and a password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ username: 'user@example.com' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 'secret' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ username: 'user@example.com', password: 'secret' })),
    true,
  );
});
