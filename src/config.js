// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` of
// `gladys-assistant-integration.json`. The SDK fetches it (`getConfig()`) and
// notifies every change (`onConfigUpdated()`); this module only provides the
// defaults and normalizes the received object, so the rest of the code never
// deals with `undefined` nor with a number arriving as a string.
// -----------------------------------------------------------------------------

import { COUNTRIES, DEFAULT_COUNTRY } from './saunierDuval/const.js';

/** Defaults, kept consistent with the `default` values of the manifest. */
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  country: DEFAULT_COUNTRY,
  // The platform is rate limited and a boiler is a slow system: polling every
  // 5 minutes is plenty, and keeps the account well away from any throttling.
  poll_frequency: 300,
  // How long a temporary setpoint override lasts on a scheduled zone, in hours.
  quick_veto_duration: 3,
};

/** Bounds enforced by the manifest, re-applied here for the API path. */
const LIMITS = {
  poll_frequency: { min: 60, max: 3600 },
  quick_veto_duration: { min: 0.5, max: 24 },
};

function clampNumber(raw, fallback, { min, max }) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Merge the user configuration with the defaults.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const country = COUNTRIES.includes(raw.country) ? raw.country : DEFAULT_CONFIG.country;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    country,
    poll_frequency: clampNumber(
      raw.poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      LIMITS.poll_frequency,
    ),
    quick_veto_duration: clampNumber(
      raw.quick_veto_duration,
      DEFAULT_CONFIG.quick_veto_duration,
      LIMITS.quick_veto_duration,
    ),
  };
}

/** Is the configuration complete enough to try to log in? */
export function isConfigured(config) {
  return Boolean(config.email && config.password);
}
