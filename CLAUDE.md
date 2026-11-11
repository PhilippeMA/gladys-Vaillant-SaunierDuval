# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Saunier Duval boilers: a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template
and follows its updates.

The boiler is reached through the Saunier Duval cloud (MiGo / MiGo Link, the
Vaillant Group platform). That API is neither documented nor supported: the
endpoints are the ones of the mobile application, and
[myPyllant](https://github.com/signalkraft/myPyllant) is the reference to check
them against.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/scenes.test.js           # one file
node --test --test-name-pattern "boost"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          starts: builds the SDK client, calls createApp, connects
src/app.js                        the integration: handlers, refresh loop, command read-back
src/saunierDuval/                 the cloud API: auth (OIDC + PKCE + ALTCHA), tiered reads, commands
src/devices/index.js              one reading of the boiler -> device models (payload, states, commands)
src/devices/<type>.js             boiler (system.js), zone, circuit, domesticHotWater
src/devices/mappings.js           boiler vocabulary <-> Gladys enumerations, supported_options
src/scenes.js                     scene action handlers (manifest `scene_actions`)
src/sceneEvents.js                scene triggers: what changed between two readings
src/widgets.js                    dashboard widget (manifest `widgets`)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: config_schema, actions, scenes, widgets, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the whole app on the SDK's fake Gladys (test/helpers/app.js)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **The platform is rate limited and shared with the mobile application.** A
  refresh cycle costs ONE request per installation (the system payload);
  installations and fault codes are re-read every 30 minutes; the dashboard
  widget is served from the last reading. `test/apiBudget.test.js` and the
  widget tests pin this: a change that adds a request per cycle, per device or
  per dashboard is a regression.
- **Devices are discovered, not declared.** An installation has one zone or
  four, a tank or none. No `poll_frequency` on the devices: the integration
  drives its own loop (`src/app.js`).
- **What Gladys refuses.** A feature needs `min` and `max` (text features
  included), a category/type pair Gladys can name and illustrate, and mode
  features declare `supported_options`. `test/discoveryPayload.test.js` replays
  those checks; `test/app.test.js` publishes through the fake Gladys, which
  refuses what the host API refuses.
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`. Gladys keys devices, their history,
  scenes and dashboards on them. The same goes for every key users store:
  manifest `config_schema`, `actions`, scene trigger and action keys with their
  fields, variables and outputs, widget keys and settings, feature keys.
- **State or event.** A value of the boiler is a device feature; a scene
  trigger is for what no feature carries as an event (a fault appearing, the
  gateway going offline), one event per transition. A scene action is for what
  a device command cannot express (a temperature with a duration).
- **The container rootfs is read-only.** Write only under `/data`. Never log
  tokens, passwords or email addresses.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language. A field
  the older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`: 5.1.0).
  `test/manifest.test.js` ties the manifest to the code: change both together.
- **User-facing text** is bilingual (English and French): status and action
  messages, widget texts, manifest texts, and `docs/en.md` / `docs/fr.md`, kept
  in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
