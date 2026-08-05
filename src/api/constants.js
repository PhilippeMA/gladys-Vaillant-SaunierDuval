// -----------------------------------------------------------------------------
// Endpoints and enumerations of the myVAILLANT cloud API.
//
// Saunier Duval appliances (MiGo, MiGo Link) are controlled through the same
// backend as Vaillant's myVAILLANT app: the brands only differ by the Keycloak
// realm used to log in. Saunier Duval is the `sdbg` brand there ("Saunier
// Duval / Bulex Group"), so the realm is `sdbg-<country>-b2c`.
//
// There is no public, documented API: these routes are the ones the mobile app
// itself calls. They are stable enough to be relied on (several community
// projects have used them for years) but they are NOT contractual — Vaillant
// can change them without notice.
// -----------------------------------------------------------------------------

/** Keycloak instance handling the authentication of every Vaillant Group brand. */
export const AUTH_BASE_URL = 'https://identity.vaillant-group.com/auth/realms';

/** OpenID Connect authorization endpoint (start of the PKCE flow). */
export const AUTHORIZE_URL = `${AUTH_BASE_URL}/{realm}/protocol/openid-connect/auth`;

/** Keycloak form-post endpoint, scraped from the HTML of the login page. */
export const LOGIN_URL = `${AUTH_BASE_URL}/{realm}/login-actions/authenticate`;

/** OpenID Connect token endpoint (code exchange + refresh). */
export const TOKEN_URL = `${AUTH_BASE_URL}/{realm}/protocol/openid-connect/token`;

/** Proof-of-work challenge served by the login page (anti-bot, see altcha.js). */
export const ALTCHA_CHALLENGE_URL = 'https://identity.vaillant-group.com/api/altcha/challenge';

/** OAuth2 client id of the mobile app, and the deep link it redirects to. */
export const CLIENT_ID = 'myvaillant';
export const REDIRECT_URI = 'enduservaillant.page.link://login';

/**
 * API roots, keyed by "control identifier" — the controller family of the
 * installation, reported by the backend itself (see getControlIdentifier).
 * `tli` covers the recent gateways (MiGo Link / VR921 / VR940f…), `vrc700`
 * the VRC700-based wired controllers.
 */
export const API_URL_BASE = {
  tli: 'https://api.vaillant-group.com/service-connected-control/end-user-app-api/v1',
  vrc700: 'https://api.vaillant-group.com/service-connected-control/vrc700/v1',
};

/** Root used by VRC700 controllers to change an operating mode. */
export const SYSTEM_CONTROL_API_URL_BASE =
  'https://api.vaillant-group.com/service-connected-control/system-control/v1';

/**
 * Subscription key of the public mobile app. It is not a user secret: the same
 * value ships inside every myVAILLANT/MiGo app install and only identifies the
 * app in front of Vaillant's API gateway.
 */
export const SUBSCRIPTION_KEY = '1e0a2f3511fb4c5bbb1c7f9fedd20b1c';

/** Brand key of Saunier Duval in the Vaillant Group identity provider. */
export const BRAND = 'sdbg';

/**
 * Countries where a Saunier Duval / Bulex account can be registered. The realm
 * is derived from it, so a wrong country makes the login fail with a 404 on
 * the authorization endpoint.
 */
export const COUNTRIES = [
  'austria',
  'czechrepublic',
  'finland',
  'france',
  'greece',
  'hungary',
  'italy',
  'lithuania',
  'luxembourg',
  'poland',
  'portugal',
  'romania',
  'slovakia',
  'spain',
];

/** Heating operating modes of a zone, on `tli` controllers. */
export const ZONE_OPERATING_MODE = {
  MANUAL: 'MANUAL',
  TIME_CONTROLLED: 'TIME_CONTROLLED',
  OFF: 'OFF',
};

/** Heating operating modes of a zone, on `vrc700` controllers. */
export const ZONE_OPERATING_MODE_VRC700 = {
  DAY: 'DAY',
  AUTO: 'AUTO',
  SET_BACK: 'SET_BACK',
  OFF: 'OFF',
};

/** Special function currently applied to a zone (holiday, temporary override…). */
export const ZONE_SPECIAL_FUNCTION = {
  NONE: 'NONE',
  QUICK_VETO: 'QUICK_VETO',
  HOLIDAY: 'HOLIDAY',
  SYSTEM_OFF: 'SYSTEM_OFF',
};

/** State of a heating circuit, i.e. what the boiler is doing right now. */
export const CIRCUIT_STATE = {
  HEATING: 'HEATING',
  COOLING: 'COOLING',
  STANDBY: 'STANDBY',
};

/** Duration, in hours, of a temporary setpoint override ("quick veto"). */
export const DEFAULT_QUICK_VETO_DURATION = 3;

/**
 * Build the Keycloak realm of a Saunier Duval account.
 * @param {string} country - Country key, e.g. 'france'.
 * @returns {string} The realm, e.g. 'sdbg-france-b2c'.
 */
export function getRealm(country) {
  return `${BRAND}-${country}-b2c`;
}
