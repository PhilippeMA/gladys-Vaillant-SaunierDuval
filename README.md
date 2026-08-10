# Saunier Duval — Gladys Assistant integration

External integration bringing a **Saunier Duval** boiler into
[Gladys Assistant](https://gladysassistant.com): heating zones, hydraulic
circuits and domestic hot water, read and controlled through the
**MiGo / MiGo Link** cloud.

Built on the official
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js).

> User documentation: [`docs/en.md`](./docs/en.md) ·
> [`docs/fr.md`](./docs/fr.md) — that is what the Configuration screen links to.

## What it exposes

Devices are **discovered**, not hard-coded: the integration reads the
installation and creates what is actually there — one zone or four, a hot water
tank or a combi boiler, one direct circuit or several.

| Device          | Features                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Boiler          | Outdoor temperature + 24 h average, heating water pressure, current activity, fault code count and detail                 |
| Heating zone    | Room temperature, room humidity (when measured), target temperature **(command)**, mode **(command)**, heating/idle state |
| Heating circuit | Flow temperature, flow setpoint, circuit state                                                                            |
| Hot water       | Water temperature, setpoint **(command)**, mode **(command)**, boost **(command)**, heating state                         |

## How it talks to the boiler

Saunier Duval boilers behind a MiGo / MiGo Link gateway are served by the
Vaillant Group "connected control" platform — Saunier Duval is the `sdbg` brand
of the same backend that powers myVAILLANT. There is **no local API**: the
integration authenticates against the Vaillant Group Keycloak with the
credentials of the mobile application, and reads/writes over HTTPS.

The API is not documented nor supported by Saunier Duval; the endpoints are the
ones its mobile application uses, and they can change without notice. This
project is not affiliated with, nor endorsed by, Saunier Duval or the Vaillant
Group.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no protocol logic)
├─ src/
│  ├─ saunierDuval/                  # ← the cloud API
│  │  ├─ const.js                    #   endpoints, realms, controller families
│  │  ├─ altcha.js                   #   proof-of-work solver required by the login page
│  │  ├─ auth.js                     #   OIDC authorization-code + PKCE login, token refresh
│  │  └─ client.js                   #   reads (one shared snapshot) and commands
│  ├─ devices/                       # ← the translation into Gladys devices
│  │  ├─ index.js                    #   snapshot -> device models, states, command routing
│  │  ├─ system.js                   #   the boiler itself
│  │  ├─ zone.js                     #   heating zone (thermostat)
│  │  ├─ circuit.js                  #   hydraulic circuit
│  │  ├─ domesticHotWater.js         #   hot water (water heater)
│  │  ├─ mappings.js                 #   boiler vocabulary <-> Gladys enumerations
│  │  └─ helpers.js                  #   rounding, state batches
│  └─ config.js                      # config defaults + normalization
├─ docs/en.md, docs/fr.md            # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

Four design points worth knowing before you edit:

- **One HTTP request per cycle, per installation.** The platform is rate
  limited and shared with the mobile application, so the read is tiered: the
  system payload (every published value comes from it) on each cycle, and a
  metadata tier — installations, controller family, fault codes — on its own
  30-minute cache. `getSnapshot()` also shares a single in-flight request, so
  everything happening inside a cycle costs nothing extra. The gateway state
  is read from the installations payload rather than from the dedicated
  endpoint, which used to be one request per cycle for a value already in
  hand. `test/apiBudget.test.js` pins the budget down.
- **Modes are declared, not guessed.** Both mode features publish
  `supported_options`, derived from the write tables in
  [`src/devices/mappings.js`](./src/devices/mappings.js) — so the interface can
  never offer a mode with no command behind it (Gladys would otherwise render
  its whole enumeration, cooling included).
- **The integration drives its own refresh loop**, and publishes no
  `poll_frequency` on its devices. The Gladys core only accepts the fixed
  frequencies of `DEVICE_POLL_FREQUENCIES` (1 s to 1 min, in **milliseconds**)
  and rejects the _whole_ discovery payload on any other value — a boiler read
  every few minutes cannot be expressed there at all. `onPoll` stays wired for
  users who enable core polling by hand on a device.
- **The setpoint write depends on the mode.** A scheduled zone gets a
  _temporary override_ (quick veto) instead of a permanent setpoint, so the
  user's schedule is never silently overwritten. See
  [`src/devices/zone.js`](./src/devices/zone.js).

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="saunier-duval" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container; the SDK reads them
automatically. Credentials come from the Gladys configuration screen, never
from the environment.

## Quality checks

The same three checks run on every push and pull request (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, via the built-in `node --test` runner
```

Tests cover the parts where a silent mistake would be expensive: the mode
mapping, which endpoint each command hits on each controller family, the
discovery of a real installation payload, and the login proof of work.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the exact checks of the store indexer — manifest, Docker image
availability, cover image, code rules — and reports every problem at once.

## Release

**Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
workflow bumps the version everywhere (`package.json` + manifest
`version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
`linux/amd64` + `linux/arm64` image to `ghcr.io`.

## License

Apache-2.0
