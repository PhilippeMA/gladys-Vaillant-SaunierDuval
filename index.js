// -----------------------------------------------------------------------------
// Entry point of the Saunier Duval integration for Gladys Assistant.
//
// This file only wires the SDK to the boiler: it holds no protocol logic. The
// cloud API lives in src/saunierDuval/, the translation into Gladys devices in
// src/devices/.
//
// Environment variables injected by the Gladys supervisor into the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them by itself: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import {
  buildDeviceModels,
  findCommand,
  statesOfDevice,
  toDiscoveredDevices,
  toStateBatches,
  toStates,
} from './src/devices/index.js';
import { AuthenticationError, SaunierDuvalClient } from './src/saunierDuval/client.js';

const gladys = new GladysIntegration();

/** Current configuration, hot-reloaded through onConfigUpdated. */
let config = normalizeConfig();

/** Client of the Saunier Duval platform, rebuilt whenever credentials change. */
let client = null;

/** Device models of the last snapshot, and the snapshot they were built from. */
let models = [];
let modelsSnapshot = null;

/**
 * Signature of the device list last published, so an unchanged list is not
 * re-sent on every cycle. Cleared whenever the core may have forgotten it
 * (reconnection) or the list may change (new configuration).
 */
let publishedDevicesSignature = null;

/**
 * Handle of the refresh loop.
 *
 * The integration drives its own refresh instead of relying on the Gladys
 * poller: the core only knows a fixed set of poll frequencies (1 s to 1 min),
 * and a boiler is read every few minutes — a rhythm that list cannot express.
 * The loop is also what makes the integration self-healing: a cycle that fails
 * (wrong credentials, platform down) is simply retried at the next tick.
 */
let refreshTimer = null;

/** Messages shown in the Configuration screen when we cannot reach the boiler. */
const STATUS = {
  NOT_CONFIGURED: {
    en: 'Enter the email and password of your MiGo / MiGo Link account.',
    fr: 'Renseignez l’e-mail et le mot de passe de votre compte MiGo / MiGo Link.',
  },
  AUTH_FAILED: {
    en: 'Login refused: check the email, the password and the country of the account.',
    fr: 'Connexion refusée : vérifiez l’e-mail, le mot de passe et le pays du compte.',
  },
  UNREACHABLE: {
    en: 'Saunier Duval platform unreachable, see the integration logs.',
    fr: 'Plateforme Saunier Duval injoignable, consultez les logs de l’intégration.',
  },
};

/** (Re)build the client for the current credentials. */
function rebuildClient() {
  client = new SaunierDuvalClient({
    email: config.email,
    password: config.password,
    country: config.country,
  });
  models = [];
  modelsSnapshot = null;
  publishedDevicesSignature = null;
}

/**
 * Device models for the current state of the boiler.
 *
 * The snapshot is cached by the client, so everything that happens inside one
 * cycle — the loop tick, a device Gladys polls itself, a command looking up
 * its handler — shares ONE read of the boiler. The models are rebuilt only
 * when the snapshot actually changed (reference comparison).
 *
 * @param {{ force?: boolean }} options re-read everything, metadata included
 */
async function getModels({ force = false } = {}) {
  if (!client) {
    rebuildClient();
  }
  const snapshot = await client.getSnapshot({
    // Half the refresh interval: fresh enough for anything happening within a
    // cycle, without a second round trip for the next caller of the same cycle.
    maxAgeMs: Math.max(30_000, (config.poll_frequency * 1000) / 2),
    force,
  });
  if (snapshot !== modelsSnapshot) {
    models = buildDeviceModels(gladys, snapshot, config);
    modelsSnapshot = snapshot;
  }
  return models;
}

/** Publish the devices and their current state, and report the status. */
async function refreshEverything({ force = false } = {}) {
  if (!isConfigured(config)) {
    logger.warn('Integration not configured yet: waiting for the credentials');
    await gladys.setConnectionStatus(false, STATUS.NOT_CONFIGURED);
    return [];
  }

  const currentModels = await getModels({ force });

  // The device LIST only changes when the installation itself changes (a zone
  // added, a gateway paired). Re-publishing an identical list every cycle just
  // makes the core re-validate the same payload, so we publish it when it
  // actually differs — and always on the first cycle after a (re)connection,
  // since the core keeps the discovered devices in memory only.
  const signature = JSON.stringify(toDiscoveredDevices(currentModels));
  if (signature !== publishedDevicesSignature) {
    await gladys.publishDiscoveredDevices(toDiscoveredDevices(currentModels));
    publishedDevicesSignature = signature;
    // Logged at info: "devices published: 0" is the first thing to look for
    // when the Discovery screen stays empty.
    logger.info(`Devices published: ${currentModels.length}`);
  }

  const states = toStates(currentModels);
  for (const batch of toStateBatches(states)) {
    await gladys.publishStates(batch);
  }
  logger.debug(`States published: ${states.length}`);

  await reportGatewayStatus();
  return currentModels;
}

/**
 * Report the application-level status from what the last snapshot already told
 * us. The platform flags a gateway it stopped hearing from as OFFLINE; when
 * that happens the values we publish are the last ones it knew, which is worth
 * saying rather than showing a healthy integration serving frozen readings.
 */
async function reportGatewayStatus() {
  const offline = (modelsSnapshot ?? []).filter((entry) => entry.online === false);
  if (offline.length === 0) {
    await gladys.setConnectionStatus(true);
    return;
  }
  const names = offline.map((entry) => entry.home?.homeName ?? entry.systemId).join(', ');
  await gladys.setConnectionStatus(false, {
    en: `Gateway offline (${names}): the values shown are the last ones known.`,
    fr: `Passerelle hors ligne (${names}) : les valeurs affichées sont les dernières connues.`,
  });
}

/** Turn any failure into the right message under the Configuration screen. */
async function reportFailure(err) {
  const message = err instanceof AuthenticationError ? STATUS.AUTH_FAILED : STATUS.UNREACHABLE;
  logger.error('Could not talk to the Saunier Duval platform', err);
  await gladys.setConnectionStatus(false, message).catch(() => {});
}

/** One refresh cycle that never throws: failures are reported, not fatal. */
async function runRefresh({ force = false } = {}) {
  try {
    return await refreshEverything({ force });
  } catch (err) {
    await reportFailure(err);
    return null;
  }
}

/**
 * (Re)start the refresh loop at the interval chosen by the user.
 *
 * A tick reads the boiler but NOT the metadata (list of installations, fault
 * codes): those live on their own slower cache in the client, so a steady
 * cycle costs one HTTP request per installation.
 */
function startRefreshLoop() {
  stopRefreshLoop();
  refreshTimer = setInterval(() => {
    runRefresh();
  }, config.poll_frequency * 1000);
}

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
// Full refresh rather than a bare re-publish: the user clicking "scan" wants
// the current state of the boiler, and a failure must be visible in the
// Configuration screen instead of dying silently inside the handler.
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the installation');
  // `force`: the user may have just added a zone or paired a gateway, so this
  // is the moment to drop the metadata cache and re-read everything.
  await runRefresh({ force: true });
});

// --- Polling: Gladys asks to refresh one device ------------------------------
gladys.onPoll(async (device) => {
  const currentModels = await getModels();
  const states = statesOfDevice(currentModels, device.external_id);
  if (states.length === 0) {
    logger.debug(`onPoll: nothing to publish for ${device.external_id}`);
    return;
  }
  await gladys.publishStates(states);
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const currentModels = await getModels();
  const command = findCommand(currentModels, feature.external_id);
  if (!command) {
    // Throwing makes the SDK acknowledge the command as failed, and Gladys
    // shows the failure instead of pretending the boiler obeyed.
    throw new Error(`No command handler for ${feature.external_id}`);
  }

  await command(client, value);

  // The boiler applies the order asynchronously and the platform can take a
  // few seconds to report it back. We publish the requested value so the UI
  // stays responsive, and invalidate the cache so the next poll republishes
  // what the boiler actually confirms.
  await gladys.publishState(feature.external_id, value);
  client.invalidateSnapshot();
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Credentials, country or refresh interval may have changed: start over.
  rebuildClient();
  await runRefresh({ force: true });
  // The interval itself may have changed: re-arm the loop on the new value.
  startRefreshLoop();
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  if (!isConfigured(config)) {
    return STATUS.NOT_CONFIGURED;
  }
  if (!client) {
    rebuildClient();
  }
  const snapshot = await client.getSnapshot({ force: true });
  if (snapshot.length === 0) {
    return {
      en: 'Connected, but no boiler is attached to this account.',
      fr: 'Connexion réussie, mais aucune chaudière n’est rattachée à ce compte.',
    };
  }
  // A successful test must leave the integration working, not just say that it
  // could: publish the devices and restart the loop right away, so the user
  // does not have to save the configuration again to see anything.
  const currentModels = await refreshEverything({ force: false });
  startRefreshLoop();

  const names = snapshot.map((entry) => entry.home.homeName ?? entry.systemId).join(', ');
  return {
    en: `Connected: ${snapshot.length} installation(s), ${currentModels.length} device(s) available (${names}).`,
    fr: `Connexion réussie : ${snapshot.length} installation(s), ${currentModels.length} appareil(s) disponible(s) (${names}).`,
  };
});

gladys.onAction('refresh', async () => {
  if (!isConfigured(config)) {
    return STATUS.NOT_CONFIGURED;
  }
  const currentModels = await refreshEverything({ force: true });
  return {
    en: `${currentModels.length} device(s) refreshed.`,
    fr: `${currentModels.length} appareil(s) actualisé(s).`,
  };
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs our own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    rebuildClient();
  } catch (err) {
    await reportFailure(err);
  }
  // The core keeps the discovered devices in memory only: a reconnection means
  // it may have forgotten them, so the next refresh must publish the list even
  // if it did not change.
  publishedDevicesSignature = null;
  // Outside the try: even a first cycle that fails must leave the loop armed,
  // otherwise a boiler that is briefly unreachable at startup would never come
  // back without the user touching the configuration.
  await runRefresh({ force: true });
  startRefreshLoop();
});

gladys.on('disconnected', () => {
  stopRefreshLoop();
});

// --- Graceful shutdown -------------------------------------------------------
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
