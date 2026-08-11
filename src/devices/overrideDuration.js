// -----------------------------------------------------------------------------
// How long a temporary override lasts, per heating zone.
//
// The Saunier Duval application asks for that duration every time you turn the
// dial on a scheduled zone: from 30 minutes to 24 hours, in 30-minute steps.
// A Gladys thermostat control carries a temperature and nothing else, so the
// duration cannot be asked for at the same moment — it is a control of its own
// on the zone device, which the user sets once and which applies to the next
// temperature they ask for.
//
// The value lives here rather than on the boiler: the platform has no register
// for "the duration I will want next time", it only takes the duration as a
// parameter of the override itself. It is seeded from what Gladys already
// stored for the feature, so it survives a restart of the integration, and
// falls back to the default of the configuration screen.
//
// The unit is MINUTES, not hours: the Gladys slider steps by 1 unit, so hours
// would make every half-hour unreachable — exactly the granularity the
// application offers.
// -----------------------------------------------------------------------------

/** Bounds and granularity of the application, in minutes. */
export const MIN_OVERRIDE_MINUTES = 30;
export const MAX_OVERRIDE_MINUTES = 24 * 60;
export const OVERRIDE_STEP_MINUTES = 30;

/** Duration chosen per zone device external_id, in minutes. */
const minutesByZone = new Map();

/**
 * Bring a duration back to what the boiler accepts: within 30 minutes and
 * 24 hours, on a 30-minute step. A slider that stops on 100 minutes becomes
 * 90, like the application would.
 *
 * @param {number} minutes requested duration
 * @returns {number|null} usable duration, or null when unreadable
 */
export function normalizeOverrideMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) {
    return null;
  }
  const stepped = Math.round(value / OVERRIDE_STEP_MINUTES) * OVERRIDE_STEP_MINUTES;
  return Math.min(Math.max(stepped, MIN_OVERRIDE_MINUTES), MAX_OVERRIDE_MINUTES);
}

/** The configured default, expressed in minutes. */
export function defaultOverrideMinutes(config) {
  return normalizeOverrideMinutes(Number(config?.quick_veto_duration) * 60) ?? MIN_OVERRIDE_MINUTES;
}

/** Duration to apply on a zone: the one chosen, or the configured default. */
export function getOverrideMinutes(deviceExternalId, config) {
  return minutesByZone.get(deviceExternalId) ?? defaultOverrideMinutes(config);
}

/** Record the duration the user just chose on a zone. */
export function setOverrideMinutes(deviceExternalId, minutes) {
  const normalized = normalizeOverrideMinutes(minutes);
  if (normalized !== null) {
    minutesByZone.set(deviceExternalId, normalized);
  }
  return normalized;
}

/**
 * Restore a duration Gladys already had for a zone, without overwriting a
 * choice made since the integration started.
 */
export function seedOverrideMinutes(deviceExternalId, minutes) {
  if (minutesByZone.has(deviceExternalId)) {
    return;
  }
  const normalized = normalizeOverrideMinutes(minutes);
  if (normalized !== null) {
    minutesByZone.set(deviceExternalId, normalized);
  }
}

/** Forget every choice (new credentials, or a test starting fresh). */
export function resetOverrideDurations() {
  minutesByZone.clear();
}
