// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest itself is validated by the store indexer, but nothing there can
// know which handlers the code registers, nor which countries the API client
// actually supports — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { COUNTRIES } from '../src/api/constants.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** Actions registered in index.js, keyed by the manifest action key. */
const REGISTERED_ACTIONS = ['test_connection'];

/** Field types the store schema accepts. */
const FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'select',
  'multi_select',
  'secret',
  'oauth2',
  'section',
];

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      REGISTERED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler in index.js`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every config field uses a supported type and a valid key', () => {
  for (const field of manifest.config_schema) {
    assert.ok(FIELD_TYPES.includes(field.type), `field "${field.key}" has an unknown type`);
    assert.match(field.key, /^[a-z0-9_]+$/, `field "${field.key}" has an invalid key`);
    assert.ok(field.label?.en, `field "${field.key}" needs an English label`);
  }
});

test('the password is a secret field, so it never reaches the browser', () => {
  const password = manifest.config_schema.find((field) => field.key === 'password');
  assert.equal(password.type, 'secret');
  // The schema forbids a default on a secret field.
  assert.equal(password.default, undefined);
  assert.equal(password.required, true);
});

test('the country list matches the countries the API client accepts', () => {
  const country = manifest.config_schema.find((field) => field.key === 'country');
  const offered = country.options.map((option) => option.value);

  assert.deepEqual([...offered].sort(), [...COUNTRIES].sort());
  assert.ok(offered.includes(DEFAULT_CONFIG.country));
});

test('the heating mode options match what the code understands', () => {
  const field = manifest.config_schema.find((f) => f.key === 'heating_on_mode');
  assert.deepEqual(
    field.options.map((option) => option.value),
    ['TIME_CONTROLLED', 'MANUAL'],
  );
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);

  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest declares the cloud transport it actually uses', () => {
  // Everything goes through the Vaillant Group cloud: declaring `local` would
  // make Gladys offer a "prefer local" toggle this integration cannot honour.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the manifest carries the fields the store requires', () => {
  for (const key of [
    'manifest_version',
    'type',
    'name',
    'description',
    'version',
    'docker_image',
    'gladys_version',
  ]) {
    assert.ok(manifest[key] !== undefined, `manifest.${key} is required`);
  }
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'the version must be strict semver');
  assert.match(manifest.docker_image, /:\d+\.\d+\.\d+$/, 'the image must carry an explicit tag');
  assert.ok(manifest.description.en && manifest.description.fr);
});

test('the docker image tag follows the manifest version', () => {
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the indexer and the image must stay in lockstep',
  );
});
