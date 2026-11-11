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
import { SCENE_TRIGGER_KEYS } from '../src/sceneEvents.js';
import { SCENE_ACTIONS } from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';
import { id } from './helpers/fakeGladys.js';
import { startApp } from './helpers/app.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

// Manifest fields older Gladys releases reject as unknown, with the first
// release accepting them. The store validator refuses a manifest whose
// `gladys_version` minimum is lower: these tests catch it before a release.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

// Minimum version of the manifest `gladys_version` range, e.g. [5, 1, 0].
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

// --- Versions ----------------------------------------------------------------

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // Older cores reject any unknown manifest field, so a manifest declaring
  // `categories` must not claim compatibility below the release accepting it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the catalog categories say what this integration actually does', () => {
  // A boiler: heating zones, hot water, setpoints and modes. The store lists
  // the comparable cloud-connected boilers under `climate` alone.
  assert.deepEqual(manifest.categories, ['climate']);
});

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.deepEqual(declared, CAPABILITY_FIELDS);
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

// --- Handlers ----------------------------------------------------------------

test('every manifest action is registered by the integration', () => {
  for (const action of manifest.actions ?? []) {
    assert.match(
      app,
      new RegExp(`onAction\\(\\s*'${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  const declared = keysOf(manifest.scene_actions);
  for (const key of declared) {
    assert.equal(typeof SCENE_ACTIONS[key], 'function', `scene action "${key}" has no handler`);
  }
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.ok(declared.includes(key), `handler "${key}" is not declared in scene_actions`);
  }
});

test('every widgets key has an onWidgetGet handler, and vice versa', () => {
  const declared = keysOf(manifest.widgets);
  for (const key of declared) {
    assert.equal(typeof WIDGETS[key]?.get, 'function', `widget "${key}" has no content handler`);
  }
  for (const key of Object.keys(WIDGETS)) {
    assert.ok(declared.includes(key), `widget "${key}" is not declared in widgets`);
  }
});

test('every scene trigger the code fires is declared in scene_triggers, and vice versa', () => {
  // An undeclared key is a 404 on publishSceneEvent; a declared key nobody
  // fires is a dead card in the scene editor.
  const declared = keysOf(manifest.scene_triggers);
  for (const key of SCENE_TRIGGER_KEYS) {
    assert.ok(declared.includes(key), `trigger "${key}" is fired but not declared`);
  }
  for (const key of declared) {
    assert.ok(SCENE_TRIGGER_KEYS.includes(key), `trigger "${key}" is declared but never fired`);
  }
});

test('every key of a fired event is declared as a filter or a variable', async () => {
  // The core keeps the declared keys only: an undeclared one is dropped, and
  // the scene author never sees the fault code they were promised.
  const t = await startApp();
  t.entries[0].troubleCodes = [
    { serialNumber: 'abc', codes: [{ code: 'F.28', title: 'Ignition failure', type: 'ERROR' }] },
  ];
  t.entries[0].online = false;
  await t.readAgain();
  t.entries[0].troubleCodes = [];
  t.entries[0].online = true;
  await t.readAgain();

  const fired = t.gladys.fake.sceneEvents;
  assert.deepEqual(
    [...new Set(fired.map((event) => event.key))].sort(),
    [...SCENE_TRIGGER_KEYS].sort(),
    'the scenario must exercise every trigger',
  );
  for (const event of fired) {
    const trigger = manifest.scene_triggers.find((candidate) => candidate.key === event.key);
    const declared = [...keysOf(trigger.fields), ...keysOf(trigger.variables)];
    for (const key of Object.keys(event.data)) {
      assert.ok(declared.includes(key), `"${event.key}" sends "${key}", which is not declared`);
    }
    for (const key of declared) {
      assert.ok(key in event.data, `"${event.key}" declares "${key}" and never sends it`);
    }
  }
  await t.stop();
});

test('every output a scene action returns is declared, and the other way round', async () => {
  // Same rule on the way back: the core drops an undeclared output.
  const t = await startApp();
  const zone = id('zone:system-1-0');
  const returned = {
    start_override: await t.gladys.fake.sceneAction('start_override', { zone, temperature: 21 }),
    cancel_override: await t.gladys.fake.sceneAction('cancel_override', { zone }),
  };

  for (const action of manifest.scene_actions) {
    assert.deepEqual(
      Object.keys(returned[action.key].data.outputs).sort(),
      keysOf(action.outputs).sort(),
      `outputs of "${action.key}"`,
    );
  }
  await t.stop();
});

// --- Configuration -----------------------------------------------------------

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
  // The override of a scene: the same 30 minutes to 24 hours, in minutes.
  const duration = manifest.scene_actions
    .find((action) => action.key === 'start_override')
    .fields.find((f) => f.key === 'duration');
  assert.equal(duration.min, 30);
  assert.equal(duration.max, 1440);
});

// --- Store rules that are easy to miss ---------------------------------------

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

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0);
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source is "devices"');
    assert.equal(
      field.options,
      undefined,
      `field "${field.key}": declaring source and options together rejects the manifest`,
    );
  }
});

test('the catalog description holds 10 to 100 characters per language', () => {
  // A store rule (the catalog card is short): a longer text rejects the
  // manifest.
  assert.ok(manifest.description.en, 'the description needs an English text');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('every text of the manifest exists in English and in French', () => {
  // The integration is bilingual: a label written in one language only shows
  // up as English in a French interface, or the other way round.
  const texts = [];
  const collect = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => collect(item, `${path}[${index}]`));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (['label', 'description', 'placeholder'].includes(key)) {
          texts.push([`${path}.${key}`, value]);
        } else {
          collect(value, `${path}.${key}`);
        }
      }
    }
  };
  collect(manifest, 'manifest');

  assert.ok(texts.length > 20);
  for (const [path, text] of texts) {
    assert.equal(typeof text, 'object', `${path} must be a multi-language object`);
    assert.ok(text.en, `${path} needs an English text`);
    assert.ok(text.fr, `${path} needs a French text`);
  }
});
