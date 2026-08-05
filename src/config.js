// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module holds the defaults and normalizes the received object, so the
// rest of the code never deals with `undefined` or with numbers arriving as
// strings from the form.
// -----------------------------------------------------------------------------

import { COUNTRIES } from './api/constants.js';

/**
 * Defaults. They MUST stay consistent with the `default` values declared in the
 * `config_schema` of the manifest (a test enforces it). `password` is a
 * `secret` field, which the manifest is not allowed to give a default.
 */
export const DEFAULT_CONFIG = {
  username: '',
  password: '',
  country: 'france',
  heating_on_mode: 'TIME_CONTROLLED',
  quick_veto_duration: 3,
  poll_frequency: 300,
};

/** Bounds also declared in the manifest, re-applied here against hand edits. */
const LIMITS = {
  quick_veto_duration: { min: 0.5, max: 24 },
  poll_frequency: { min: 60, max: 3600 },
};

/**
 * Merge the user configuration with the defaults and coerce the types.
 * @param {Record<string, unknown>} [raw] - Configuration returned by the SDK.
 * @returns {object} The normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    username: String(raw.username ?? DEFAULT_CONFIG.username).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    // An unknown country would build an unknown Keycloak realm and fail the
    // login with a confusing 404.
    country: COUNTRIES.includes(raw.country) ? raw.country : DEFAULT_CONFIG.country,
    heating_on_mode: raw.heating_on_mode === 'MANUAL' ? 'MANUAL' : 'TIME_CONTROLLED',
    quick_veto_duration: bounded(
      raw.quick_veto_duration,
      DEFAULT_CONFIG.quick_veto_duration,
      LIMITS.quick_veto_duration,
    ),
    poll_frequency: bounded(
      raw.poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      LIMITS.poll_frequency,
    ),
  };
}

/**
 * Whether the integration has everything it needs to talk to the cloud.
 * @param {object} config - Normalized configuration.
 * @returns {boolean} True when credentials are set.
 */
export function isConfigured(config) {
  return Boolean(config.username && config.password);
}

/**
 * Coerce a value to a number inside its bounds, falling back to the default.
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Default value.
 * @param {{min: number, max: number}} limits - Accepted range.
 * @returns {number} The bounded number.
 */
function bounded(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
