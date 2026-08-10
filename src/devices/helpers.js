// -----------------------------------------------------------------------------
// Small shared helpers for the device modules.
// -----------------------------------------------------------------------------

/**
 * Round a measurement to one decimal. The boiler reports raw sensor values
 * (8.019531 °C), which would otherwise pollute the history and the charts.
 * Returns null for anything that is not a finite number, so the caller can
 * simply skip the state instead of publishing a NaN.
 */
export function round1(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

/**
 * Build a `publishStates` batch, dropping the entries whose value could not be
 * read. A boiler does not report every field on every installation, and
 * publishing a null would create a meaningless point in the history.
 *
 * @param {Array<[string, number|null]>} entries `[featureExternalId, state]`
 */
export function numericStates(entries) {
  return entries
    .filter(([, state]) => state !== null && state !== undefined)
    .map(([device_feature_external_id, state]) => ({ device_feature_external_id, state }));
}

/** Same as `numericStates`, for the text features. */
export function textStates(entries) {
  return entries
    .filter(([, text]) => typeof text === 'string' && text.length > 0)
    .map(([device_feature_external_id, text]) => ({ device_feature_external_id, text }));
}

/**
 * Human-readable name of an installation, used as the prefix of every device
 * name so several boilers on one account stay distinguishable.
 */
export function systemLabel(home) {
  const name = (home?.homeName ?? '').trim();
  return name.length > 0 ? name : 'Saunier Duval';
}
