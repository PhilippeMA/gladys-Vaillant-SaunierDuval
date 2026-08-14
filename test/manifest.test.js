// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { COUNTRIES } from '../src/saunierDuval/const.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const entryPoint = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action is registered by the entry point', () => {
  for (const action of manifest.actions ?? []) {
    assert.match(
      entryPoint,
      new RegExp(`onAction\\(\\s*'${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The vocabulary itself is checked by the store validator (unknown keys are
  // dropped with a warning there) — what this pins is the coupling rule: older
  // cores reject any unknown manifest field, so a manifest declaring
  // `categories` must not claim compatibility below the release accepting it.
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    'the catalog accepts 1 to 3 categories',
  );
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the catalog categories say what this integration actually does', () => {
  // A boiler: heating zones, hot water, setpoints and modes. The store lists
  // the comparable cloud-connected boilers (De Dietrich, Daikin) under
  // `climate` alone, and its own fallback file already classifies this
  // repository that way — the manifest now says so itself.
  assert.deepEqual(manifest.categories, ['climate']);
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

test('every stored config field is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config field "${field.key}" has no entry in DEFAULT_CONFIG`,
    );
  }
});

test('the country options are exactly the realms Saunier Duval serves', () => {
  const field = manifest.config_schema.find((f) => f.key === 'country');
  const values = field.options.map((option) => option.value);
  assert.deepEqual([...values].sort(), [...COUNTRIES].sort());
});

test('the password is a secret field, never sent back to the browser', () => {
  const field = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(field.type, 'secret');
  // The schema rejects a default on a secret, and a default password would be
  // a credential committed to a public repository.
  assert.equal(field.default, undefined);
});

test('the integration declares itself as cloud-only', () => {
  // Everything goes through the Saunier Duval platform: claiming `local` would
  // show a "prefer the local connection" toggle that could never be honoured.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('numeric fields declare the same bounds the code enforces', () => {
  const pollFrequency = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.equal(pollFrequency.min, 60);
  assert.equal(pollFrequency.max, 3600);
  const quickVeto = manifest.config_schema.find((f) => f.key === 'quick_veto_duration');
  assert.equal(quickVeto.min, 0.5);
  assert.equal(quickVeto.max, 24);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest version and the docker image tag stay in step', () => {
  // The indexer serves whatever `version` says: a stale tag would ship the
  // previous image under a new version number.
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged ${manifest.version}`,
  );
});
