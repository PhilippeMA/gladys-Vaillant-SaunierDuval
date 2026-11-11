// -----------------------------------------------------------------------------
// The integration itself: everything that wires the Gladys SDK to the boiler.
//
// It lives here rather than in index.js so the tests can run it for real: they
// hand `createApp` the fake Gladys of the SDK and a client answering from
// fixtures, then connect, and check what Gladys actually received. index.js
// only builds the real ones and starts.
//
// No protocol logic in this file: the cloud API is in src/saunierDuval/, the
// translation into Gladys devices in src/devices/, the scene actions in
// src/scenes.js, the scene triggers in src/sceneEvents.js and the dashboard
// widget in src/widgets.js.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './config.js';
import {
  buildDeviceModels,
  findCommand,
  seedOverrideDurationsFromDevices,
  statesOfDevice,
  toDiscoveredDevices,
  toStateBatches,
  toStates,
} from './devices/index.js';
import { AuthenticationError, SaunierDuvalClient } from './saunierDuval/client.js';
import { createSceneEventDetector } from './sceneEvents.js';
import { SCENE_ACTIONS } from './scenes.js';
import { WIDGETS, refreshWidgets } from './widgets.js';

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

/**
 * How long after a command the boiler is read again. The platform takes a few
 * seconds to report what the boiler did with an order; reading too early
 * would publish the old state back over the value the user just set.
 */
const DEFAULT_CONFIRM_DELAY_MS = 8_000;

/**
 * Wire an integration onto a Gladys client. Handlers are registered here,
 * before `gladys.connect()`.
 *
 * @param {object} gladys a GladysIntegration (or the fake one of the SDK)
 * @param {object} [options]
 * @param {Function} [options.createClient] builds the Saunier Duval client
 *   from `{ email, password, country }` — replaced in the tests
 * @param {number} [options.confirmDelayMs] delay of the read-back after a command
 * @returns {{ runtime: object, settle: Function }}
 */
export function createApp(
  gladys,
  {
    createClient = (credentials) => new SaunierDuvalClient(credentials),
    confirmDelayMs = DEFAULT_CONFIRM_DELAY_MS,
  } = {},
) {
  /** Current configuration, hot-reloaded through onConfigUpdated. */
  let config = normalizeConfig();

  /** Client of the Saunier Duval platform, rebuilt whenever credentials change. */
  let client = null;

  /** Device models of the last reading, and the snapshot they were built from. */
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
   * The integration drives its own refresh rather than declaring a
   * `poll_frequency` on its devices: Gladys polls once a minute at the
   * slowest and one device at a time, where one request to the platform
   * refreshes the whole installation every few minutes. The loop is also what
   * makes the integration self-healing: a cycle that fails (wrong credentials,
   * platform down) is simply retried at the next tick.
   */
  let refreshTimer = null;

  /** Pending read-back after a command, and the promise of the one running. */
  let confirmTimer = null;
  let confirmation = Promise.resolve();

  const sceneEvents = createSceneEventDetector();

  /** (Re)build the client for the current credentials. */
  function rebuildClient() {
    client = createClient({
      email: config.email,
      password: config.password,
      country: config.country,
    });
    models = [];
    modelsSnapshot = null;
    publishedDevicesSignature = null;
    // Another account is another installation: its faults are not "new".
    sceneEvents.reset();
  }

  /**
   * What happens once per NEW reading of the boiler, whoever asked for it:
   * fire the scene triggers of what changed, and nudge the dashboard widget.
   * Neither may break a refresh: a failure is logged and the cycle goes on.
   */
  async function onNewReading() {
    for (const event of sceneEvents.detect(models)) {
      try {
        logger.info(`Scene trigger ${event.key} (${JSON.stringify(event.data)})`);
        await gladys.publishSceneEvent(event.key, event.data);
      } catch (err) {
        logger.error(`Could not publish the scene trigger ${event.key}`, err);
      }
    }
    refreshWidgets(gladys);
  }

  /**
   * Device models for the current state of the boiler.
   *
   * The snapshot is cached by the client, so everything that happens inside
   * one cycle — the loop tick, a device Gladys polls itself, a command looking
   * up its handler — shares ONE read of the boiler. The models are rebuilt
   * only when the snapshot actually changed (reference comparison).
   *
   * @param {{ force?: boolean, fresh?: boolean }} options `fresh` reads the
   *   boiler again; `force` also drops the metadata (installations, faults)
   */
  async function getModels({ force = false, fresh = false } = {}) {
    if (!client) {
      rebuildClient();
    }
    const snapshot = await client.getSnapshot({
      // Half the refresh interval: fresh enough for anything happening within
      // a cycle, without a second round trip for the next caller of the cycle.
      maxAgeMs: fresh ? 0 : Math.max(30_000, (config.poll_frequency * 1000) / 2),
      force,
    });
    if (snapshot !== modelsSnapshot) {
      models = buildDeviceModels(gladys, snapshot, config);
      modelsSnapshot = snapshot;
      await onNewReading();
    }
    return models;
  }

  /**
   * The models of the last reading, whatever its age: what the dashboard
   * widget is built from. A card being displayed must never cost a call to
   * the platform — only the very first one, when nothing was read yet.
   */
  async function getLatestModels() {
    return modelsSnapshot ? models : getModels();
  }

  /** Publish the devices and their current state, and report the status. */
  async function refreshEverything({ force = false, fresh = false } = {}) {
    if (!isConfigured(config)) {
      logger.warn('Integration not configured yet: waiting for the credentials');
      await gladys.setConnectionStatus(false, STATUS.NOT_CONFIGURED);
      return [];
    }

    const currentModels = await getModels({ force, fresh });

    // The device LIST only changes when the installation itself changes (a
    // zone added, a gateway paired). Re-publishing an identical list every
    // cycle just makes the core re-validate the same payload, so we publish it
    // when it actually differs — and always on the first cycle after a
    // (re)connection, since the core keeps the discovered devices in memory.
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
   * Report the application-level status from what the last snapshot already
   * told us. The platform flags a gateway it stopped hearing from as OFFLINE;
   * the values we publish are then the last ones it knew, which is worth
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

  /**
   * Read back the override durations Gladys already holds for our zones. A
   * failure here is not worth a visible error: the configured default applies.
   */
  async function restoreOverrideDurations() {
    try {
      const restored = seedOverrideDurationsFromDevices(await gladys.getDevices());
      if (restored > 0) {
        logger.debug(`Override durations restored: ${restored}`);
      }
    } catch (err) {
      logger.debug('Could not read back the override durations', err.message);
    }
  }

  /** One refresh cycle that never throws: failures are reported, not fatal. */
  async function runRefresh(options) {
    try {
      return await refreshEverything(options);
    } catch (err) {
      await reportFailure(err);
      return null;
    }
  }

  /**
   * (Re)start the refresh loop at the interval chosen by the user.
   *
   * A tick reads the boiler but NOT the metadata (list of installations,
   * fault codes): those live on their own slower cache in the client, so a
   * steady cycle costs one HTTP request per installation.
   */
  function startRefreshLoop() {
    stopRefreshLoop();
    refreshTimer = setInterval(() => {
      runRefresh();
    }, config.poll_frequency * 1000);
    // The WebSocket keeps the process alive; this timer must not by itself.
    refreshTimer.unref?.();
  }

  function stopRefreshLoop() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /**
   * Everything a command has in common once the platform accepted it.
   *
   * The boiler applies an order asynchronously, so: show the requested value
   * right away (a responsive interface), drop the cached reading, and read the
   * boiler again a few seconds later to publish what it actually did. Several
   * commands in a row share one read-back.
   *
   * @param {string} [featureExternalId] feature to show the requested value on
   * @param {number} [value] the requested value
   */
  async function commandApplied(featureExternalId, value) {
    if (featureExternalId !== undefined) {
      await gladys.publishState(featureExternalId, value);
    }
    client.invalidateSnapshot();

    clearTimeout(confirmTimer);
    confirmation = new Promise((resolve) => {
      confirmTimer = setTimeout(() => {
        confirmTimer = null;
        runRefresh({ fresh: true }).then(resolve);
      }, confirmDelayMs);
    });
  }

  /** Run the command of a controllable feature: a device control, or a button. */
  async function runCommand(featureExternalId, value) {
    const command = findCommand(await getModels(), featureExternalId);
    if (!command) {
      // Throwing makes the SDK acknowledge the command as failed, and Gladys
      // shows the failure instead of pretending the boiler obeyed.
      throw new Error(`No command handler for ${featureExternalId}`);
    }
    await command(client, value);
    await commandApplied(featureExternalId, value);
  }

  /** What the scene actions and the widget are given to work with. */
  const runtime = {
    get config() {
      return config;
    },
    get client() {
      return client;
    },
    isConfigured: () => isConfigured(config),
    getModels,
    getLatestModels,
    runCommand,
    commandApplied,
    refresh: () => refreshEverything({ fresh: true }),
  };

  // --- Discovery: Gladys asks for the list of devices -------------------------
  // Full refresh rather than a bare re-publish: the user clicking "scan" wants
  // the current state of the boiler, and a failure must be visible in the
  // Configuration screen instead of dying silently inside the handler.
  gladys.onScanRequest(async () => {
    logger.info('onScanRequest -> reading the installation');
    // `force`: the user may have just added a zone or paired a gateway, so
    // this is the moment to drop the metadata cache and re-read everything.
    publishedDevicesSignature = null;
    await runRefresh({ force: true });
  });

  // --- Polling: only for a device the user turned polling on by hand ----------
  gladys.onPoll(async (device) => {
    const states = statesOfDevice(await getModels(), device.external_id);
    if (states.length > 0) {
      await gladys.publishStates(states);
    }
  });

  // --- A device was just created or updated from the Discovery screen ---------
  // Gladys silently drops the states of a feature that does not exist yet, so
  // a new device would stay empty until the next cycle. Give it its values
  // now, from the reading we already hold: no call to the platform.
  const publishStatesOfDevice = async (device) => {
    if (!modelsSnapshot) {
      return;
    }
    const states = statesOfDevice(models, device.external_id);
    if (states.length > 0) {
      await gladys.publishStates(states).catch((err) => {
        logger.debug(`Could not publish the states of ${device.external_id}`, err.message);
      });
    }
  };
  gladys.onDeviceCreated(publishStatesOfDevice);
  gladys.onDeviceUpdated(publishStatesOfDevice);

  // --- Command: the user acts on a controllable feature -----------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await runCommand(feature.external_id, value);
  });

  // --- Scene actions (manifest `scene_actions`) -------------------------------
  // Scene TRIGGERS need no handler: they are fired from onNewReading.
  for (const [actionKey, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(actionKey, (fields) => handler(gladys, { fields, runtime }));
  }

  // --- Dashboard widgets (manifest `widgets`) ---------------------------------
  for (const [widgetKey, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(widgetKey, (request) => widget.get(gladys, { ...request, runtime }));
    gladys.onWidgetAction(widgetKey, (actionKey, params, { settings } = {}) =>
      widget.action(gladys, { actionKey, params, settings, runtime }),
    );
  }

  // --- Configuration updated by the user --------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    // Credentials, country or refresh interval may have changed: start over.
    rebuildClient();
    await runRefresh({ force: true });
    // The interval itself may have changed: re-arm the loop on the new value.
    startRefreshLoop();
    // Even a refresh that failed changes what the card must say.
    refreshWidgets(gladys);
  });

  // --- Manifest actions: buttons in the Configuration screen ------------------
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
    // A successful test must leave the integration working, not just say that
    // it could: publish the devices and restart the loop right away, so the
    // user does not have to save the configuration again to see anything.
    const currentModels = await refreshEverything();
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

  // --- Connection lifecycle ---------------------------------------------------
  // The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
  // this handler only runs our own (re)initialization.
  gladys.on('connected', async () => {
    try {
      config = normalizeConfig(await gladys.getConfig());
      rebuildClient();
    } catch (err) {
      await reportFailure(err);
    }
    // The core keeps the discovered devices in memory only: a reconnection
    // means it may have forgotten them, so the next refresh must publish the
    // list even if it did not change.
    publishedDevicesSignature = null;
    // The override durations the user chose live in this process; Gladys kept
    // their last value, so read them back before the first refresh republishes
    // them — a restart must not silently fall back to the configured default.
    await restoreOverrideDurations();
    // Outside the try: even a first cycle that fails must leave the loop
    // armed, otherwise a boiler that is briefly unreachable at startup would
    // never come back without the user touching the configuration.
    await runRefresh({ force: true });
    startRefreshLoop();
    // The nudges sent while the socket was down were dropped.
    refreshWidgets(gladys);
  });

  gladys.on('disconnected', () => {
    stopRefreshLoop();
    clearTimeout(confirmTimer);
  });

  // --- Graceful shutdown ------------------------------------------------------
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopRefreshLoop();
    clearTimeout(confirmTimer);
  });

  return {
    runtime,
    /** Resolves once the read-back of the last command is done (tests). */
    settle: () => confirmation,
  };
}
