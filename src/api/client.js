// -----------------------------------------------------------------------------
// Client of the myVAILLANT cloud API, for Saunier Duval installations.
//
// Everything the integration knows about the heating system goes through here:
//   - authentication and token lifecycle (delegated to auth.js);
//   - reading a normalized snapshot of every system and heating zone;
//   - writing the two things the user can act on: the target temperature and
//     whether heating runs at all.
//
// One HTTP round trip per system is enough to read all the sensors, so the
// snapshot is cached for a few seconds: several Gladys devices poll at the same
// time and must not multiply the calls to a rate-limited cloud API.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  API_URL_BASE,
  CIRCUIT_STATE,
  DEFAULT_QUICK_VETO_DURATION,
  SUBSCRIPTION_KEY,
  SYSTEM_CONTROL_API_URL_BASE,
  ZONE_OPERATING_MODE,
  ZONE_OPERATING_MODE_VRC700,
  ZONE_SPECIAL_FUNCTION,
} from './constants.js';
import { AuthenticationFailedError, login, refreshToken } from './auth.js';

const logger = createLogger({ name: 'saunier-duval-api' });

const REQUEST_TIMEOUT_MS = 20_000;

/** Renew the access token this many seconds before it actually expires. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * Lifetime of the installation list. Long on purpose: pairing a gateway is a
 * rare, manual gesture, and discovery refetches the list anyway — so a refresh
 * cycle costs one call per installation instead of two.
 */
const HOMES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Bounds of a room setpoint, matching what the MiGo controllers accept. */
export const MIN_SETPOINT = 5;
export const MAX_SETPOINT = 30;

/** Raised when the API answers, but not with what we expect. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class SaunierDuvalClient {
  /**
   * @param {object} options - Client options.
   * @param {string} options.username - Account email address.
   * @param {string} options.password - Account password.
   * @param {string} options.country - Country key, e.g. 'france'.
   * @param {number} [options.cacheTtl] - Snapshot cache lifetime, in seconds.
   */
  constructor({ username, password, country, cacheTtl = 30 }) {
    this.username = username;
    this.password = password;
    this.country = country;
    this.cacheTtlMs = cacheTtl * 1000;

    this.session = null;
    this.sessionExpiresAt = 0;
    /** Serializes concurrent logins so a burst of polls triggers only one. */
    this.pendingAuth = null;

    /** Control identifier ('tli' | 'vrc700'), cached per system id. */
    this.controlIdentifiers = new Map();

    /**
     * The installations of the account. They only change when the user pairs
     * or removes a gateway, so they are cached far longer than the readings:
     * refetching them on every cycle would double the calls for nothing.
     */
    this.homes = null;
    this.homesAt = 0;

    this.snapshot = null;
    this.snapshotAt = 0;
    this.pendingSnapshot = null;

    /** Total API calls made, so the refresh cost stays observable in the logs. */
    this.requestCount = 0;
  }

  // --- Authentication --------------------------------------------------------

  /**
   * Return a valid access token, logging in or refreshing as needed.
   * @returns {Promise<string>} The access token.
   */
  async getAccessToken() {
    if (this.session && Date.now() < this.sessionExpiresAt - TOKEN_SAFETY_MARGIN_MS) {
      return this.session.access_token;
    }
    // Concurrent callers share the same in-flight authentication.
    this.pendingAuth = this.pendingAuth ?? this.authenticate();
    try {
      return await this.pendingAuth;
    } finally {
      this.pendingAuth = null;
    }
  }

  /**
   * Refresh the session when possible, otherwise log in from scratch.
   * @returns {Promise<string>} The access token.
   */
  async authenticate() {
    if (this.session?.refresh_token) {
      try {
        logger.debug('Refreshing the myVAILLANT session');
        this.storeSession(
          await refreshToken({ refreshToken: this.session.refresh_token, country: this.country }),
        );
        return this.session.access_token;
      } catch (err) {
        logger.info(`Session refresh failed (${err.message}), logging in again`);
      }
    }

    logger.info(`Logging in to the Saunier Duval cloud as ${this.username}`);
    this.storeSession(
      await login({ username: this.username, password: this.password, country: this.country }),
    );
    return this.session.access_token;
  }

  /**
   * Store a token set and compute its expiry.
   * @param {{access_token: string, refresh_token: string, expires_in: number}} tokens - The token set.
   */
  storeSession(tokens) {
    if (!tokens?.access_token) {
      throw new AuthenticationFailedError('The identity provider returned no access token');
    }
    this.session = tokens;
    this.sessionExpiresAt = Date.now() + (tokens.expires_in ?? 300) * 1000;
  }

  /** Drop every cached value (used when the config changes). */
  reset() {
    this.session = null;
    this.sessionExpiresAt = 0;
    this.controlIdentifiers.clear();
    this.homes = null;
    this.homesAt = 0;
    this.invalidateSnapshot();
  }

  // --- HTTP ------------------------------------------------------------------

  /**
   * Perform an authenticated API call, retrying once after a re-login if the
   * token was rejected.
   * @param {string} url - Absolute URL.
   * @param {object} [options] - Method and JSON body.
   * @param {string} [options.method] - HTTP method, defaults to GET.
   * @param {object} [options.body] - Body, serialized as JSON.
   * @returns {Promise<object|null>} The parsed body, or null when empty.
   */
  async request(url, { method = 'GET', body } = {}) {
    let response = await this.rawRequest(url, { method, body });

    if (response.status === 401) {
      logger.debug('Access token rejected, forcing a new authentication');
      this.session = null;
      response = await this.rawRequest(url, { method, body });
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new ApiError(
        `${method} ${url} failed with HTTP ${response.status}: ${detail}`,
        response.status,
      );
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Single authenticated HTTP round trip, without retry.
   * @param {string} url - Absolute URL.
   * @param {object} options - Method and JSON body.
   * @param {string} options.method - HTTP method.
   * @param {object} [options.body] - Body, serialized as JSON.
   * @returns {Promise<Response>} The raw response.
   */
  async rawRequest(url, { method, body }) {
    const token = await this.getAccessToken();
    this.requestCount += 1;
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-GB',
        'x-app-identifier': 'VAILLANT',
        'x-client-locale': 'en-GB',
        'x-idm-identifier': 'KEYCLOAK',
        'ocp-apim-subscription-key': SUBSCRIPTION_KEY,
        'User-Agent': 'okhttp/4.9.2',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  // --- Reading ---------------------------------------------------------------

  /**
   * List the homes (installations) attached to the account, from a long-lived
   * cache: a refresh cycle needs the system ids, not a fresh inventory of the
   * account. Discovery and the connection test pass `force` to pick up a
   * gateway paired since the integration started.
   * @param {object} [options] - Read options.
   * @param {boolean} [options.force] - Refetch instead of using the cache.
   * @returns {Promise<Array<object>>} The raw homes.
   */
  async getHomes({ force = false } = {}) {
    if (!force && this.homes && Date.now() - this.homesAt < HOMES_CACHE_TTL_MS) {
      return this.homes;
    }
    const homes = await this.request(`${API_URL_BASE.tli}/homes`);
    this.homes = (homes ?? []).filter((home) => Boolean(home.systemId));
    this.homesAt = Date.now();
    return this.homes;
  }

  /**
   * Controller family of a system, which decides the API routes to use.
   * @param {string} systemId - System identifier.
   * @returns {Promise<string>} 'tli' or 'vrc700'.
   */
  async getControlIdentifier(systemId) {
    if (this.controlIdentifiers.has(systemId)) {
      return this.controlIdentifiers.get(systemId);
    }
    const body = await this.request(
      `${API_URL_BASE.tli}/systems/${systemId}/meta-info/control-identifier`,
    );
    // Anything unknown is driven with the `tli` routes, which cover the vast
    // majority of the Saunier Duval gateways.
    const identifier = body?.controlIdentifier === 'vrc700' ? 'vrc700' : 'tli';
    this.controlIdentifiers.set(systemId, identifier);
    return identifier;
  }

  /**
   * Root of the per-system routes, which differs between controller families.
   * @param {string} systemId - System identifier.
   * @param {string} controlIdentifier - 'tli' or 'vrc700'.
   * @returns {string} The base URL.
   */
  getSystemApiBase(systemId, controlIdentifier) {
    return controlIdentifier === 'vrc700'
      ? `${API_URL_BASE.vrc700}/systems/${systemId}`
      : `${API_URL_BASE.tli}/systems/${systemId}/tli`;
  }

  /**
   * Read every system of the account, normalized and cached.
   * @param {object} [options] - Read options.
   * @param {boolean} [options.force] - Ignore the snapshot cache.
   * @param {boolean} [options.refreshHomes] - Also refetch the installations.
   * @returns {Promise<Array<object>>} The normalized systems.
   */
  async getSystems({ force = false, refreshHomes = false } = {}) {
    if (!force && this.snapshot && Date.now() - this.snapshotAt < this.cacheTtlMs) {
      return this.snapshot;
    }
    // Collapse a burst of concurrent polls into a single fetch.
    this.pendingSnapshot = this.pendingSnapshot ?? this.fetchSystems({ refreshHomes });
    try {
      const systems = await this.pendingSnapshot;
      this.snapshot = systems;
      this.snapshotAt = Date.now();
      return systems;
    } finally {
      this.pendingSnapshot = null;
    }
  }

  /** Force the next getSystems() call to hit the API. */
  invalidateSnapshot() {
    this.snapshot = null;
    this.snapshotAt = 0;
  }

  /**
   * Fetch and normalize every system, without touching the snapshot cache.
   * @param {object} [options] - Read options.
   * @param {boolean} [options.refreshHomes] - Also refetch the installations.
   * @returns {Promise<Array<object>>} The normalized systems.
   */
  async fetchSystems({ refreshHomes = false } = {}) {
    const homes = await this.getHomes({ force: refreshHomes });
    const systems = [];

    for (const home of homes) {
      const controlIdentifier = await this.getControlIdentifier(home.systemId);
      const raw = await this.request(this.getSystemApiBase(home.systemId, controlIdentifier));
      systems.push(normalizeSystem({ home, raw, controlIdentifier }));
    }
    return systems;
  }

  /**
   * Find one zone in the current snapshot.
   * @param {string} systemId - System identifier.
   * @param {number} zoneIndex - Zone index.
   * @returns {Promise<{system: object, zone: object}>} The system and its zone.
   */
  async getZone(systemId, zoneIndex) {
    const systems = await this.getSystems();
    const system = systems.find((candidate) => candidate.id === systemId);
    const zone = system?.zones.find((candidate) => candidate.index === zoneIndex);
    if (!zone) {
      throw new ApiError(`Zone ${zoneIndex} of system ${systemId} is not reported by the API`);
    }
    return { system, zone };
  }

  // --- Writing ---------------------------------------------------------------

  /**
   * Set the target room temperature of a zone.
   *
   * How it is applied depends on how the zone currently runs, so that the value
   * the user sets in Gladys is the value the controller actually aims for:
   *   - running on its schedule: a temporary override ("quick veto") lasting
   *     `durationHours`, exactly like turning the dial on the thermostat;
   *   - running in manual mode: the manual setpoint itself, permanently;
   *   - switched off: heating is turned back on in manual mode at that
   *     temperature, since asking for a temperature means asking for heat.
   * @param {object} options - Command inputs.
   * @param {string} options.systemId - System identifier.
   * @param {number} options.zoneIndex - Zone index.
   * @param {number} options.temperature - Target temperature, in Celsius.
   * @param {number} [options.durationHours] - Quick veto duration.
   * @returns {Promise<number>} The temperature actually requested.
   */
  async setTargetTemperature({
    systemId,
    zoneIndex,
    temperature,
    durationHours = DEFAULT_QUICK_VETO_DURATION,
  }) {
    const setpoint = clampSetpoint(temperature);
    const { system, zone } = await this.getZone(systemId, zoneIndex);
    const base = this.getSystemApiBase(systemId, system.controlIdentifier);
    const isVrc700 = system.controlIdentifier === 'vrc700';
    const manualMode = isVrc700 ? ZONE_OPERATING_MODE_VRC700.DAY : ZONE_OPERATING_MODE.MANUAL;

    if (zone.operationMode === ZONE_OPERATING_MODE.OFF) {
      logger.info(`Zone ${zoneIndex} is off: switching it to ${manualMode} at ${setpoint}°C`);
      await this.setOperationMode({ systemId, zoneIndex, mode: manualMode });
      await this.writeManualSetpoint({ base, zoneIndex, setpoint, isVrc700 });
    } else if (zone.operationMode === manualMode) {
      await this.writeManualSetpoint({ base, zoneIndex, setpoint, isVrc700 });
    } else {
      await this.writeQuickVeto({ base, zone, zoneIndex, setpoint, isVrc700, durationHours });
    }

    this.invalidateSnapshot();
    return setpoint;
  }

  /**
   * Write the permanent manual-mode setpoint of a zone.
   * @param {object} options - Command inputs.
   * @param {string} options.base - System API base URL.
   * @param {number} options.zoneIndex - Zone index.
   * @param {number} options.setpoint - Target temperature.
   * @param {boolean} options.isVrc700 - Whether the controller is a VRC700.
   */
  async writeManualSetpoint({ base, zoneIndex, setpoint, isVrc700 }) {
    if (isVrc700) {
      // VRC700 has no manual-mode-setpoint route: its DAY mode is driven by the
      // comfort room temperature.
      await this.request(`${base}/zone/${zoneIndex}/heating/comfort-room-temperature`, {
        method: 'PATCH',
        body: { comfortRoomTemperature: setpoint },
      });
      return;
    }
    await this.request(`${base}/zones/${zoneIndex}/manual-mode-setpoint`, {
      method: 'PATCH',
      body: { setpoint, type: 'HEATING' },
    });
  }

  /**
   * Apply a temporary setpoint override to a zone running on its schedule.
   * @param {object} options - Command inputs.
   * @param {string} options.base - System API base URL.
   * @param {object} options.zone - Normalized zone.
   * @param {number} options.zoneIndex - Zone index.
   * @param {number} options.setpoint - Target temperature.
   * @param {boolean} options.isVrc700 - Whether the controller is a VRC700.
   * @param {number} options.durationHours - Override duration.
   */
  async writeQuickVeto({ base, zone, zoneIndex, setpoint, isVrc700, durationHours }) {
    const url = isVrc700
      ? `${base}/zone/${zoneIndex}/heating/quick-veto`
      : `${base}/zones/${zoneIndex}/quick-veto`;

    // An override already running is updated in place; creating a second one
    // is refused by the API.
    if (zone.specialFunction === ZONE_SPECIAL_FUNCTION.QUICK_VETO) {
      await this.request(url, {
        method: 'PATCH',
        body: { desiredRoomTemperatureSetpoint: setpoint },
      });
      return;
    }
    await this.request(url, {
      method: 'POST',
      body: { desiredRoomTemperatureSetpoint: setpoint, duration: durationHours },
    });
  }

  /**
   * Turn the heating of a zone on or off.
   * @param {object} options - Command inputs.
   * @param {string} options.systemId - System identifier.
   * @param {number} options.zoneIndex - Zone index.
   * @param {boolean} options.enabled - Whether heating must run.
   * @param {string} [options.onMode] - Mode to restore when turning on,
   *   'TIME_CONTROLLED' (the schedule) or 'MANUAL'.
   * @returns {Promise<string>} The operating mode actually applied.
   */
  async setHeatingEnabled({ systemId, zoneIndex, enabled, onMode = 'TIME_CONTROLLED' }) {
    const { system } = await this.getZone(systemId, zoneIndex);
    const isVrc700 = system.controlIdentifier === 'vrc700';
    const mode = enabled ? resolveOnMode(onMode, isVrc700) : ZONE_OPERATING_MODE.OFF;

    await this.setOperationMode({ systemId, zoneIndex, mode });
    this.invalidateSnapshot();
    return mode;
  }

  /**
   * Write the heating operating mode of a zone.
   * @param {object} options - Command inputs.
   * @param {string} options.systemId - System identifier.
   * @param {number} options.zoneIndex - Zone index.
   * @param {string} options.mode - Target operating mode.
   */
  async setOperationMode({ systemId, zoneIndex, mode }) {
    const controlIdentifier = await this.getControlIdentifier(systemId);
    // VRC700 controllers take their operating modes on the system-control API,
    // not on the route serving their state.
    const url =
      controlIdentifier === 'vrc700'
        ? `${SYSTEM_CONTROL_API_URL_BASE}/systems/${systemId}/zones/${zoneIndex}/heating-operation-mode`
        : `${this.getSystemApiBase(systemId, controlIdentifier)}/zones/${zoneIndex}/heating-operation-mode`;

    await this.request(url, { method: 'PATCH', body: { operationMode: mode } });
  }
}

/**
 * Map the configured "turn heating back on" mode to the vocabulary of the
 * controller family.
 * @param {string} onMode - 'TIME_CONTROLLED' or 'MANUAL'.
 * @param {boolean} isVrc700 - Whether the controller is a VRC700.
 * @returns {string} The operating mode to write.
 */
export function resolveOnMode(onMode, isVrc700) {
  if (!isVrc700) {
    return onMode === 'MANUAL' ? ZONE_OPERATING_MODE.MANUAL : ZONE_OPERATING_MODE.TIME_CONTROLLED;
  }
  return onMode === 'MANUAL' ? ZONE_OPERATING_MODE_VRC700.DAY : ZONE_OPERATING_MODE_VRC700.AUTO;
}

/**
 * Keep a setpoint inside the range the controllers accept.
 * @param {number} temperature - Requested temperature.
 * @returns {number} The clamped temperature, rounded to half a degree.
 */
export function clampSetpoint(temperature) {
  const bounded = Math.min(MAX_SETPOINT, Math.max(MIN_SETPOINT, Number(temperature)));
  return Math.round(bounded * 2) / 2;
}

/**
 * Turn the raw system payload into the flat shape the devices consume.
 * @param {object} options - Raw inputs.
 * @param {object} options.home - Entry of GET /homes.
 * @param {object} options.raw - Body of the system endpoint.
 * @param {string} options.controlIdentifier - 'tli' or 'vrc700'.
 * @returns {object} The normalized system.
 */
export function normalizeSystem({ home, raw, controlIdentifier }) {
  const state = raw?.state ?? {};
  const configuration = raw?.configuration ?? {};
  const properties = raw?.properties ?? {};
  const circuits = state.circuits ?? [];

  return {
    id: home.systemId,
    name: home.homeName || home.nomenclature || 'Saunier Duval',
    serialNumber: home.serialNumber ?? null,
    productType: home.productMetadata?.productType ?? home.nomenclature ?? null,
    controlIdentifier,
    outdoorTemperature: numberOrNull(state.system?.outdoorTemperature),
    waterPressure: numberOrNull(state.system?.systemWaterPressure),
    // "The boiler is working": at least one circuit is actively producing.
    heatingActive: circuits.some((circuit) => circuit.circuitState === CIRCUIT_STATE.HEATING),
    circuitStates: circuits.map((circuit) => circuit.circuitState ?? null),
    zones: (state.zones ?? []).map((zoneState) =>
      normalizeZone({ zoneState, configuration, properties }),
    ),
  };
}

/**
 * Merge the state and the configuration of one zone.
 * @param {object} options - Raw inputs.
 * @param {object} options.zoneState - Entry of `state.zones`.
 * @param {object} options.configuration - `configuration` block of the system.
 * @param {object} options.properties - `properties` block of the system.
 * @returns {object} The normalized zone.
 */
function normalizeZone({ zoneState, configuration, properties }) {
  const index = zoneState.index ?? 0;
  const byIndex = (entry) => entry.index === index;
  const zoneConfig = (configuration.zones ?? []).find(byIndex) ?? {};
  const zoneProperties = (properties.zones ?? []).find(byIndex) ?? {};
  const heating = zoneConfig.heating ?? {};

  // TLI names it manualModeSetpointHeating, VRC700 dayTemperatureHeating: both
  // are "the comfort temperature configured for this zone".
  const comfortSetpoint = numberOrNull(
    heating.manualModeSetpointHeating ?? heating.dayTemperatureHeating,
  );
  const setBackTemperature = numberOrNull(heating.setBackTemperature);

  return {
    index,
    name: zoneConfig.general?.name?.trim() || `Zone ${index + 1}`,
    isActive: zoneProperties.isActive !== false,
    currentTemperature: numberOrNull(zoneState.currentRoomTemperature),
    humidity: numberOrNull(zoneState.currentRoomHumidity),
    operationMode: heating.operationModeHeating ?? null,
    specialFunction: zoneState.currentSpecialFunction ?? ZONE_SPECIAL_FUNCTION.NONE,
    heatingState: zoneState.heatingState ?? null,
    heatingEnabled: heating.operationModeHeating !== ZONE_OPERATING_MODE.OFF,
    comfortSetpoint,
    setBackTemperature,
    targetTemperature: resolveTargetTemperature({
      desired: numberOrNull(zoneState.desiredRoomTemperatureSetpoint),
      desiredHeating: numberOrNull(zoneState.desiredRoomTemperatureSetpointHeating),
      comfortSetpoint,
      setBackTemperature,
    }),
  };
}

/**
 * Pick the setpoint to expose as "target temperature".
 *
 * The API reports 0 as the desired setpoint whenever the zone is asking for no
 * heat at all (switched off, or outside the slots of its schedule). Zero is not
 * a temperature a user can act on, so we fall back to the setpoint that WOULD
 * apply — the configured comfort temperature, then the setback temperature.
 * @param {object} candidates - Candidate setpoints, most specific first.
 * @param {number|null} candidates.desired - Effective desired setpoint.
 * @param {number|null} candidates.desiredHeating - Desired heating setpoint.
 * @param {number|null} candidates.comfortSetpoint - Configured comfort setpoint.
 * @param {number|null} candidates.setBackTemperature - Configured setback setpoint.
 * @returns {number|null} The target temperature, or null when unknown.
 */
export function resolveTargetTemperature({
  desired,
  desiredHeating,
  comfortSetpoint,
  setBackTemperature,
}) {
  for (const candidate of [desired, desiredHeating, comfortSetpoint, setBackTemperature]) {
    if (candidate !== null && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Coerce an API value to a number, mapping anything unusable to null.
 * @param {unknown} value - Raw value.
 * @returns {number|null} The number, or null.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
