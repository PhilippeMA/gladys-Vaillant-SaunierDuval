// -----------------------------------------------------------------------------
// Entry point of the Saunier Duval integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the API client and to the device registry.
// It holds no heating logic — reading and writing lives in src/api/, mapping to
// Gladys devices in src/devices/. Here we only:
//   1. instantiate the SDK (connection, auth, reconnection: handled for us);
//   2. register the event handlers BEFORE connect();
//   3. keep one API client alive, rebuilt whenever the credentials change.
//
// Environment variables injected by the Gladys supervisor into the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import { SaunierDuvalClient } from './src/api/client.js';
import { AuthenticationFailedError } from './src/api/auth.js';
import {
  buildDiscoveredDevices,
  pollDevice,
  refreshAllDevices,
  setDeviceValue,
} from './src/devices/index.js';
import { testConnection } from './src/actions.js';

/**
 * Lifetime of the shared system snapshot, in seconds. All the devices of an
 * installation are polled at nearly the same time and read the same payload:
 * this window collapses that burst into a single call to a rate-limited cloud.
 */
const SNAPSHOT_CACHE_TTL = 20;

const gladys = new GladysIntegration();

let config = normalizeConfig();
let client = null;

// Timer of the integration's own refresh loop (see refreshAllDevices).
let refreshTimer = null;

/**
 * Return the API client, building it on first use. Returns null while the user
 * has not filled in the credentials yet.
 * @returns {SaunierDuvalClient|null} The client, or null.
 */
function getClient() {
  if (!isConfigured(config)) {
    return null;
  }
  client = client ?? buildClient();
  return client;
}

/**
 * Build a client from the current configuration.
 * @returns {SaunierDuvalClient} The client.
 */
function buildClient() {
  logger.info(`Using the Saunier Duval account ${config.username} (${config.country})`);
  return new SaunierDuvalClient({
    username: config.username,
    password: config.password,
    country: config.country,
    cacheTtl: SNAPSHOT_CACHE_TTL,
  });
}

/**
 * Return the client or fail loudly: used by the handlers that cannot do
 * anything useful without credentials.
 * @returns {SaunierDuvalClient} The client.
 */
function requireClient() {
  const current = getClient();
  if (!current) {
    throw new Error('The Saunier Duval account is not configured yet');
  }
  return current;
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the Saunier Duval account');
  await publishDevices();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  // Throwing acks the command as failed, and Gladys shows the failure.
  await setDeviceValue(gladys, { device, feature, value }, { client: requireClient(), config });
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The devices declare no `poll_frequency` (Gladys caps its intervals at one
// minute, see src/devices/thermostat.js), so this fires only on an on-demand
// refresh; the periodic reads come from the loop below.
gladys.onPoll(async (device) => {
  await pollDevice(gladys, device, { client: requireClient(), config });
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', () => testConnection(requireClient()));

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // The credentials, the country or the polling interval may have changed:
  // start from a clean client rather than reusing a session opened with the
  // previous account.
  client = null;
  await initialize();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name, so this handler only runs
// the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
  } catch (err) {
    logger.error('Could not read the integration configuration', err);
    return;
  }
  await initialize();
});

// Publishing states over a closed socket only produces noise: the loop restarts
// from the 'connected' handler once the SDK has reconnected.
gladys.on('disconnected', () => {
  stopRefreshLoop();
});

/**
 * (Re)publish the devices and report the application-level status shown in the
 * Configuration screen. Distinct from the container state machine: the
 * integration can be running and still unable to reach the Saunier Duval cloud.
 */
async function initialize() {
  if (!isConfigured(config)) {
    logger.warn('Waiting for the Saunier Duval credentials to be filled in');
    await setStatus(false, {
      en: 'Fill in the email address and the password of your MiGo account.',
      fr: "Renseignez l'adresse e-mail et le mot de passe de votre compte MiGo.",
    });
    return;
  }

  try {
    await publishDevices();
    await setStatus(true);
    // Publish a first set of values immediately, so the devices the user
    // creates are not empty until the first tick.
    await refreshStates();
    startRefreshLoop();
  } catch (err) {
    logger.error('Initialization failed', err);
    stopRefreshLoop();
    await setStatus(false, statusMessage(err));
  }
}

/**
 * Read the whole account and publish every value, logging but swallowing
 * failures: a cloud hiccup must not kill the timer.
 */
async function refreshStates() {
  try {
    await refreshAllDevices(gladys, { client: requireClient(), config });
  } catch (err) {
    logger.error('Refreshing the Saunier Duval values failed', err);
  }
}

/** (Re)start the refresh loop at the interval chosen by the user. */
function startRefreshLoop() {
  stopRefreshLoop();
  logger.info(`Refreshing the values every ${config.poll_frequency}s`);
  refreshTimer = setInterval(refreshStates, config.poll_frequency * 1000);
}

/** Stop the refresh loop, if it runs. */
function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Read the account and publish everything it contains.
 * `publishDiscoveredDevices` is idempotent (upsert by external_id), so calling
 * it again after a configuration change is safe.
 */
async function publishDevices() {
  const devices = await buildDiscoveredDevices(gladys, { client: requireClient(), config });
  await gladys.publishDiscoveredDevices(devices);
}

/**
 * Report the connection status, never letting a reporting failure mask the
 * error that caused it.
 * @param {boolean} connected - Whether the cloud is reachable.
 * @param {object} [message] - Multi-language explanation.
 */
async function setStatus(connected, message) {
  await gladys.setConnectionStatus(connected, message).catch((err) => {
    logger.error('Could not report the connection status', err);
  });
}

/**
 * Turn an initialization failure into something actionable for the user.
 * @param {Error} err - The failure.
 * @returns {{en: string, fr: string}} The message shown in the Configuration screen.
 */
function statusMessage(err) {
  if (err instanceof AuthenticationFailedError) {
    return {
      en: 'Login refused: check the email address, the password and the country of your MiGo account.',
      fr: "Connexion refusée : vérifiez l'adresse e-mail, le mot de passe et le pays de votre compte MiGo.",
    };
  }
  return {
    en: 'Could not reach the Saunier Duval cloud, check the integration logs.',
    fr: "Impossible de joindre le cloud Saunier Duval, consultez les logs de l'intégration.",
  };
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Saunier Duval integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
