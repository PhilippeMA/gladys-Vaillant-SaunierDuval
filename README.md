# Saunier Duval — Gladys Assistant integration

External integration connecting [Gladys Assistant](https://gladysassistant.com)
to **Saunier Duval** heating systems (MiGo, MiGo Link), built on the official
[JavaScript SDK](https://github.com/GladysAssistant/integration-sdk-js) and the
[integration template](https://github.com/GladysAssistant/integration-template-js).

| Capability                   | Feature                             | Read | Write |
| ---------------------------- | ----------------------------------- | :--: | :---: |
| Thermostat temperature       | `thermostat` → `temperature`        |  ✅  |       |
| Thermostat humidity          | `thermostat` → `humidity`           |  ✅  |       |
| Target temperature           | `thermostat` → `target-temperature` |  ✅  |  ✅   |
| Heating on / off             | `thermostat` → `heating`            |  ✅  |  ✅   |
| Outdoor temperature          | `boiler` → `outdoor-temperature`    |  ✅  |       |
| Boiler state (firing / idle) | `boiler` → `state`                  |  ✅  |       |
| Water pressure               | `boiler` → `water-pressure`         |  ✅  |       |

User documentation: [`docs/en.md`](./docs/en.md) · [`docs/fr.md`](./docs/fr.md).

## How it works

Saunier Duval appliances are driven by the **myVAILLANT cloud**: the MiGo app
and the myVAILLANT app talk to the same backend, and only the Keycloak realm
differs per brand. Saunier Duval is the `sdbg` brand there, so an account
registered in France lives in the `sdbg-france-b2c` realm.

There is no public, documented API. The routes used here are the ones the mobile
app itself calls — the same ones the community projects
[myPyllant](https://github.com/signalkraft/myPyllant),
[VaillantCloud](https://github.com/rmalbrecht/VaillantCloud) and
[iobroker.vaillant](https://www.npmjs.com/package/iobroker.vaillant) rely on.
They are stable in practice but **not contractual**: Vaillant can change them
without notice.

### Authentication

The app uses an OAuth2 authorization-code flow with PKCE whose redirect URI is a
mobile deep link a server cannot receive, and the login page is protected by an
[ALTCHA](https://altcha.org) proof of work. So the integration drives the login
form itself:

1. start the PKCE flow on the authorization endpoint, keeping the Keycloak
   session cookies ([`src/api/cookieJar.js`](./src/api/cookieJar.js) — Node's
   `fetch` stores none);
2. read the form action out of the returned login page;
3. solve the ALTCHA challenge ([`src/api/altcha.js`](./src/api/altcha.js));
4. post the credentials and read the authorization code from the redirect;
5. exchange it for an access + refresh token.

Tokens are then refreshed in the background; a rejected refresh falls back to a
full login.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no heating logic)
├─ src/
│  ├─ api/
│  │  ├─ constants.js                #   endpoints, brands, countries, modes
│  │  ├─ cookieJar.js                #   minimal cookie jar for the login flow
│  │  ├─ altcha.js                   #   ALTCHA proof-of-work solver
│  │  ├─ auth.js                     #   OAuth2 + PKCE login and token refresh
│  │  └─ client.js                   #   read a snapshot, write setpoint & mode
│  ├─ devices/
│  │  ├─ index.js                    #   registry: discovery + routing
│  │  ├─ thermostat.js               #   one per heating zone (read + write)
│  │  └─ boiler.js                   #   one per installation (read only)
│  ├─ actions.js                     # "Test the connection" button
│  └─ config.js                      # config defaults + normalization
├─ docs/{en,fr}.md                   # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
└─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
```

Unlike a fixed device list, the devices here are **discovered**: an account may
hold several installations and each installation several heating zones. The
registry therefore enumerates device _types_ and routes every poll and command
by parsing the external id Gladys sends back
([`src/devices/externalIds.js`](./src/devices/externalIds.js)).

One HTTP round trip per installation reads every sensor, so the snapshot is
cached for a few seconds: all the devices poll at nearly the same time and must
not multiply the calls to a rate-limited cloud.

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
integration runs inside its sandboxed container.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, via the built-in `node --test` runner
```

The same three gates run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Tests never touch the
network: the HTTP layer of the client is replaced by fixtures shaped like real
API payloads ([`test/helpers/`](./test/helpers)).

Before tagging a release, check the integration against the store validator:

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
   workflow bumps the version everywhere (`package.json` + manifest
   `version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest version and Gladys offers
   a one-click install.

Replace [`cover.png`](./cover.png) (800×534 px, ≤150 KB) before publishing: the
bundled one is the template's placeholder gradient.

## License

Apache-2.0
