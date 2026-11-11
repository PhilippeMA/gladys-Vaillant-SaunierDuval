# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- **Ventilation boost** on the boiler device: the airing function of the
  control, the one the Saunier Duval application offers on every installation.
  A switch, usable from the dashboard and from scenes.
- **Dashboard widget** "Saunier Duval boiler": room, hot water and outdoor
  temperatures, water pressure, the state of each zone in the words of the
  Saunier Duval application (manual, schedule, off), the gateway, the faults,
  and buttons for the hot water boost, the ventilation boost and a reading on
  demand. Displaying it never costs a request to the Saunier Duval platform.
- **Scene triggers**: a fault code appears on the boiler (with its code, title
  and description as scene variables), the faults are cleared, the gateway goes
  offline, the gateway comes back online.
- **Scene actions**: "Override a zone temperature" — a temperature and a
  duration in one operation, like the Saunier Duval application does — and
  "Cancel a zone override".
- A device created from the Discovery screen shows its values at once instead
  of at the next refresh cycle.
- `CHANGELOG.md`, rolled by the Release workflow, and a GitHub Release for
  every version with its changelog section as notes.
- `SECURITY.md`, `CLAUDE.md`, Dependabot for the npm dependencies and the
  GitHub Actions; the CI runs the tests on Node 22 and 24 and builds the Docker
  image.

### Changed

- **Gladys 5.1.0 or later is required**, the first release with dashboard
  widgets and scene triggers and actions for integrations.
- After a command, the boiler is read again a few seconds later and the value
  it confirms is published: the dashboard no longer waits for the next refresh
  cycle to show what the boiler actually did.
- Integration SDK 0.16.0. The tests now run the whole integration against the
  fake Gladys of the SDK, which refuses the payloads Gladys refuses.
- Node.js 22 or later is required (Node 20 is end-of-life).

### Fixed

- The Release workflow no longer re-prints the manifest in another layout: the
  release commit left `npm run format:check` failing on the default branch.
- The integration can write to `/data`: the image creates the directory owned
  by the `node` user, a new Docker volume was owned by root.

## [1.0.2] - 2026-08-14

### Changed

- Gladys 4.86.0 or later is required; the integration is listed under the
  `climate` category of the catalog.
- Integration SDK 0.12.0.

## [1.0.1] - 2026-08-11

### Added

- First release from this repository: boiler, heating zones, heating circuits
  and domestic hot water of a Saunier Duval installation, through the MiGo /
  MiGo Link cloud.
- "Override duration" control on each heating zone, from 30 minutes to 24
  hours in 30-minute steps.

[Unreleased]: https://github.com/PhilippeMA/gladys-Vaillant-SaunierDuval/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/PhilippeMA/gladys-Vaillant-SaunierDuval/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/PhilippeMA/gladys-Vaillant-SaunierDuval/releases/tag/v1.0.1
