// -----------------------------------------------------------------------------
// Client of the Saunier Duval cloud API.
//
// Reads the state of the installation ("system") and sends the commands the
// boiler accepts: heating setpoint per zone, zone operating mode, hot water
// setpoint / mode / boost.
//
// Two things this module is careful about:
//   - the platform is rate limited, so ONE snapshot is fetched per cycle and
//     shared by every Gladys device (`getSnapshot`, with a short TTL and a
//     single in-flight request);
//   - endpoints differ between the two controller families (`tli` for MiGo
//     Link and recent controllers, `vrc700` for older MiPro / Exacontrol),
//     so each write method branches on the control identifier of the system.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AuthenticationError, VaillantAuth } from './auth.js';
import {
  API_HEADERS,
  CONTROL_IDENTIFIERS,
  HTTP_TIMEOUT_MS,
  SYSTEM_CONTROL_API_URL_BASE,
  ZONE_SPECIAL_FUNCTIONS,
  getApiBase,
  getSystemApiBase,
} from './const.js';

const logger = createLogger({ name: 'client' });

/**
 * How long the "metadata tier" is trusted: the list of installations and the
 * fault codes. These do not move at the rhythm of a temperature, and reading
 * them on every cycle tripled the number of requests for nothing.
 */
const METADATA_TTL_MS = 30 * 60 * 1000;

/** Raised for any non-2xx answer of the API. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The vrc700 payloads name the hot water circuits `domesticHotWater` where the
 * tli ones use `dhw`. One accessor for both.
 */
function dhwSection(section) {
  return section?.dhw ?? section?.domesticHotWater ?? [];
}

export class SaunierDuvalClient {
  /**
   * @param {{ email: string, password: string, country: string }} credentials
   */
  constructor({ email, password, country }) {
    this.auth = new VaillantAuth({ email, password, country });
    /** Control identifier per system id, stable for the life of an installation. */
    this.controlIdentifiers = new Map();
    /** Metadata tier: the list of installations. `{ value, fetchedAt }`. */
    this.homesCache = { value: null, fetchedAt: 0 };
    /** Metadata tier: fault codes per system id. */
    this.troubleCodesCache = new Map();
    this.snapshot = null;
    this.snapshotFetchedAt = 0;
    this.pendingSnapshot = null;
  }

  /** Forget the session and every cached read (configuration changed). */
  reset() {
    this.auth.reset();
    this.controlIdentifiers.clear();
    this.invalidateMetadata();
    this.invalidateSnapshot();
  }

  /**
   * Drop the metadata tier, so the next read goes back to the platform for the
   * list of installations and the fault codes. Used when the user explicitly
   * asks for a scan: they may have just added a zone or paired a gateway.
   */
  invalidateMetadata() {
    this.homesCache = { value: null, fetchedAt: 0 };
    this.troubleCodesCache.clear();
  }

  /**
   * Mark the cached snapshot as stale without dropping it: the next read goes
   * back to the boiler. Called after a command, so the confirmed values are
   * re-read instead of trusting what we asked for.
   */
  invalidateSnapshot() {
    this.snapshotFetchedAt = 0;
  }

  // --- HTTP ------------------------------------------------------------------

  /**
   * Authenticated call to the platform. A 401 means the token was rejected:
   * we drop the session and try once more with a fresh one.
   */
  async request(method, url, body, { retryOnUnauthorized = true } = {}) {
    const accessToken = await this.auth.getAccessToken();
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401 && retryOnUnauthorized) {
      logger.debug('Got a 401, renewing the session');
      this.auth.reset();
      return this.request(method, url, body, { retryOnUnauthorized: false });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status, `${method} ${url} -> HTTP ${response.status} ${text}`);
    }

    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  get(url) {
    return this.request('GET', url);
  }

  // --- Read ------------------------------------------------------------------

  /**
   * The installations (one per gateway) attached to the account.
   *
   * Metadata tier: an account does not gain a boiler between two refreshes, so
   * this is read once per METADATA_TTL_MS instead of once per cycle. The
   * payload also carries `onlineState`, which is why the integration no longer
   * calls the dedicated connection-status endpoint — that was one HTTP request
   * per cycle for something already in hand.
   */
  async getHomes() {
    if (this.homesCache.value && Date.now() - this.homesCache.fetchedAt < METADATA_TTL_MS) {
      return this.homesCache.value;
    }
    const body = await this.get(`${getApiBase()}/homes`);
    const homes = (body ?? []).filter((home) => home.systemId);
    this.homesCache = { value: homes, fetchedAt: Date.now() };
    return homes;
  }

  /** Controller family of a system; cached for good, it does not change. */
  async getControlIdentifier(systemId) {
    if (this.controlIdentifiers.has(systemId)) {
      return this.controlIdentifiers.get(systemId);
    }
    const body = await this.get(`${getApiBase()}/systems/${systemId}/meta-info/control-identifier`);
    const identifier = body?.controlIdentifier ?? CONTROL_IDENTIFIERS.TLI;
    this.controlIdentifiers.set(systemId, identifier);
    return identifier;
  }

  /**
   * Full state + properties + configuration of one system: THE call of a
   * refresh cycle. Every value the integration publishes — temperatures,
   * pressure, setpoints, modes, circuit and hot water state — comes from this
   * single payload.
   */
  getSystem(systemId, controlIdentifier) {
    return this.get(getSystemApiBase(systemId, controlIdentifier));
  }

  /**
   * Fault / maintenance codes reported by the appliances of a system.
   * Metadata tier: a boiler fault is an event, not a measurement, so reading
   * it every few minutes buys nothing.
   */
  async getDiagnosticTroubleCodes(systemId) {
    const cached = this.troubleCodesCache.get(systemId);
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS) {
      return cached.value;
    }
    const body = await this.get(
      `${getApiBase()}/systems/${systemId}/diagnostic-trouble-codes`,
    ).catch((err) => {
      logger.debug(`Could not read the fault codes of ${systemId}`, err.message);
      return null;
    });
    // On failure, keep serving the previous list rather than pretending the
    // boiler suddenly has no fault at all.
    const codes = Array.isArray(body) ? body : (cached?.value ?? []);
    this.troubleCodesCache.set(systemId, { value: codes, fetchedAt: Date.now() });
    return codes;
  }

  /**
   * One coherent read of everything the integration exposes.
   *
   * Cost in HTTP requests, once warm: ONE per installation per cycle (the
   * system payload). The list of installations, the controller family and the
   * fault codes are served from their own caches — see the tiers above.
   *
   * @param {{ maxAgeMs?: number, force?: boolean }} options `force` also drops
   *   the metadata tier: everything is read again from the platform.
   * @returns {Promise<Array<{ home: object, systemId: string, controlIdentifier: string,
   *   system: object, online: boolean|null, troubleCodes: Array }>>}
   */
  async getSnapshot({ maxAgeMs = 0, force = false } = {}) {
    if (!force && this.snapshot && Date.now() - this.snapshotFetchedAt < maxAgeMs) {
      return this.snapshot;
    }
    if (force) {
      this.invalidateMetadata();
    }
    if (!this.pendingSnapshot) {
      this.pendingSnapshot = this.#fetchSnapshot().finally(() => {
        this.pendingSnapshot = null;
      });
    }
    return this.pendingSnapshot;
  }

  async #fetchSnapshot() {
    const homes = await this.getHomes();
    const systems = [];

    for (const home of homes) {
      const systemId = home.systemId;
      const controlIdentifier = await this.getControlIdentifier(systemId);
      if (!Object.values(CONTROL_IDENTIFIERS).includes(controlIdentifier)) {
        logger.warn(
          `System ${systemId} runs an unsupported controller (${controlIdentifier}), skipped`,
        );
        continue;
      }
      systems.push({
        home,
        systemId,
        controlIdentifier,
        system: await this.getSystem(systemId, controlIdentifier),
        // Read from the homes payload: the platform reports the gateway as
        // OFFLINE when it stopped talking to it. Unknown states are treated as
        // online rather than raising a false alarm.
        online: home.onlineState === undefined ? null : home.onlineState !== 'OFFLINE',
        troubleCodes: await this.getDiagnosticTroubleCodes(systemId),
      });
    }

    this.snapshot = systems;
    this.snapshotFetchedAt = Date.now();
    logger.debug(`Snapshot refreshed: ${systems.length} system(s)`);
    return systems;
  }

  // --- Write: heating zones --------------------------------------------------

  /**
   * Change the heating mode of a zone.
   * @param {object} target `{ systemId, controlIdentifier, index }`
   * @param {string} mode platform mode (MANUAL / TIME_CONTROLLED / OFF, or
   *   DAY / AUTO / SET_BACK / OFF on a vrc700 controller)
   */
  setZoneOperatingMode({ systemId, controlIdentifier, index }, mode) {
    const url =
      controlIdentifier === CONTROL_IDENTIFIERS.VRC700
        ? `${SYSTEM_CONTROL_API_URL_BASE}/systems/${systemId}/zones/${index}/heating-operation-mode`
        : `${getSystemApiBase(systemId, controlIdentifier)}/zones/${index}/heating-operation-mode`;
    return this.request('PATCH', url, { operationMode: mode });
  }

  /**
   * Setpoint of a zone running in manual mode (`MANUAL` on tli, `DAY` on
   * vrc700, where the app writes the comfort temperature instead).
   */
  setZoneManualSetpoint({ systemId, controlIdentifier, index }, temperature) {
    if (controlIdentifier === CONTROL_IDENTIFIERS.VRC700) {
      return this.request(
        'PATCH',
        `${getSystemApiBase(systemId, controlIdentifier)}/zone/${index}/heating/comfort-room-temperature`,
        { comfortRoomTemperature: temperature },
      );
    }
    return this.request(
      'PATCH',
      `${getSystemApiBase(systemId, controlIdentifier)}/zones/${index}/manual-mode-setpoint`,
      { setpoint: temperature, type: 'HEATING' },
    );
  }

  /**
   * Temporarily override the setpoint of a zone that follows its schedule
   * ("quick veto"). Extending an override in progress is a PATCH, starting a
   * new one is a POST.
   */
  setZoneQuickVeto(
    { systemId, controlIdentifier, index, currentSpecialFunction },
    temperature,
    durationHours,
  ) {
    const url =
      controlIdentifier === CONTROL_IDENTIFIERS.VRC700
        ? `${getSystemApiBase(systemId, controlIdentifier)}/zone/${index}/heating/quick-veto`
        : `${getSystemApiBase(systemId, controlIdentifier)}/zones/${index}/quick-veto`;

    if (currentSpecialFunction === ZONE_SPECIAL_FUNCTIONS.QUICK_VETO) {
      return this.request('PATCH', url, { desiredRoomTemperatureSetpoint: temperature });
    }
    return this.request('POST', url, {
      desiredRoomTemperatureSetpoint: temperature,
      duration: durationHours,
    });
  }

  /** Cancel an override in progress. */
  cancelZoneQuickVeto({ systemId, controlIdentifier, index }) {
    const url =
      controlIdentifier === CONTROL_IDENTIFIERS.VRC700
        ? `${getSystemApiBase(systemId, controlIdentifier)}/zone/${index}/heating/quick-veto`
        : `${getSystemApiBase(systemId, controlIdentifier)}/zones/${index}/quick-veto`;
    return this.request('DELETE', url);
  }

  // --- Write: domestic hot water ---------------------------------------------

  /** Hot water setpoint. tli controllers only accept whole degrees. */
  setDomesticHotWaterTemperature({ systemId, controlIdentifier, index }, temperature) {
    if (controlIdentifier === CONTROL_IDENTIFIERS.VRC700) {
      return this.request(
        'PATCH',
        `${SYSTEM_CONTROL_API_URL_BASE}/systems/${systemId}/domestic-hot-water/${index}/tapping-setpoint`,
        { setpoint: temperature },
      );
    }
    return this.request(
      'PATCH',
      `${getSystemApiBase(systemId, controlIdentifier)}/domestic-hot-water/${index}/temperature`,
      { setpoint: Math.round(temperature) },
    );
  }

  /** Hot water operating mode (MANUAL / TIME_CONTROLLED / OFF, or DAY / AUTO / OFF). */
  setDomesticHotWaterOperationMode({ systemId, controlIdentifier, index }, mode) {
    return this.request(
      'PATCH',
      `${getSystemApiBase(systemId, controlIdentifier)}/domestic-hot-water/${index}/operation-mode`,
      { operationMode: mode },
    );
  }

  /** Start or stop a hot water boost (one-off tank heating). */
  setDomesticHotWaterBoost({ systemId, controlIdentifier, index }, enabled) {
    const url = `${getSystemApiBase(systemId, controlIdentifier)}/domestic-hot-water/${index}/boost`;
    return enabled ? this.request('POST', url, {}) : this.request('DELETE', url);
  }
}

export { AuthenticationError, dhwSection };
