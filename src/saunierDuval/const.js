// -----------------------------------------------------------------------------
// Constants of the Saunier Duval cloud API (MiGo / MiGo Link).
//
// Saunier Duval boilers connected through a MiGo Link (or MiGo) gateway are
// served by the Vaillant Group "connected control" platform: Saunier Duval is
// one of the brands (`sdbg`) of the same backend that powers myVAILLANT.
// Authentication is an OpenID Connect authorization-code + PKCE flow against
// the Vaillant Group Keycloak, using the brand/country realm of the account.
//
// This API is NOT documented nor supported by Saunier Duval: the endpoints
// below are the ones the official mobile application uses. They can change
// without notice.
// -----------------------------------------------------------------------------

/** Keycloak base, one realm per brand + country. */
export const AUTH_BASE_URL = 'https://identity.vaillant-group.com/auth/realms';
export const AUTHENTICATE_URL = `${AUTH_BASE_URL}/{realm}/protocol/openid-connect/auth`;
export const LOGIN_URL = `${AUTH_BASE_URL}/{realm}/login-actions/authenticate`;
export const TOKEN_URL = `${AUTH_BASE_URL}/{realm}/protocol/openid-connect/token`;

/**
 * Proof-of-work challenge (ALTCHA) the login page asks for before accepting
 * the credentials. Solved locally, see altcha.js.
 */
export const ALTCHA_CHALLENGE_URL = 'https://identity.vaillant-group.com/api/altcha/challenge';

/** OAuth2 client of the mobile application. */
export const CLIENT_ID = 'myvaillant';
/** Deep link the authorization code is redirected to (never actually opened). */
export const REDIRECT_URI = 'enduservaillant.page.link://login';

/** Brand of this integration: Saunier Duval / Bulex / Glow-worm share `sdbg`. */
export const BRAND = 'sdbg';

/**
 * Countries where a Saunier Duval account can be registered. The realm is
 * `sdbg-<country>-b2c`, so an account created in France cannot log in through
 * the Spanish realm: the user picks their country in the configuration.
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

export const DEFAULT_COUNTRY = 'france';

/**
 * API roots, one per controller family ("control identifier"):
 *   - tli    : MiGo Link gateways and recent controllers (MiPro Sense...)
 *   - vrc700 : older MiPro / Exacontrol E7/E8 controllers behind a MiGo
 * The platform tells us which one applies through the meta-info endpoint.
 */
export const API_URL_BASE = {
  tli: 'https://api.vaillant-group.com/service-connected-control/end-user-app-api/v1',
  vrc700: 'https://api.vaillant-group.com/service-connected-control/vrc700/v1',
};

/** A few write endpoints of the vrc700 family live on their own root. */
export const SYSTEM_CONTROL_API_URL_BASE =
  'https://api.vaillant-group.com/service-connected-control/system-control/v1';

/** Controller families we know how to read. */
export const CONTROL_IDENTIFIERS = {
  TLI: 'tli',
  VRC700: 'vrc700',
};

/** Headers the mobile application sends on every API call. */
export const API_HEADERS = {
  'x-app-identifier': 'VAILLANT',
  'x-client-locale': 'en-GB',
  'x-idm-identifier': 'KEYCLOAK',
  'ocp-apim-subscription-key': '1e0a2f3511fb4c5bbb1c7f9fedd20b1c',
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'okhttp/4.9.2',
};

/** Zone heating modes, per controller family. */
export const ZONE_OPERATING_MODES = {
  tli: { MANUAL: 'MANUAL', TIME_CONTROLLED: 'TIME_CONTROLLED', OFF: 'OFF' },
  vrc700: { DAY: 'DAY', AUTO: 'AUTO', SET_BACK: 'SET_BACK', OFF: 'OFF' },
};

/** Domestic hot water modes, per controller family. */
export const DHW_OPERATING_MODES = {
  tli: { MANUAL: 'MANUAL', TIME_CONTROLLED: 'TIME_CONTROLLED', OFF: 'OFF' },
  vrc700: { DAY: 'DAY', AUTO: 'AUTO', OFF: 'OFF' },
};

/** Special function reported by a zone (quick veto = temporary override). */
export const ZONE_SPECIAL_FUNCTIONS = {
  NONE: 'NONE',
  QUICK_VETO: 'QUICK_VETO',
  HOLIDAY: 'HOLIDAY',
  SYSTEM_OFF: 'SYSTEM_OFF',
};

/** Special function reported by the hot water circuit. */
export const DHW_SPECIAL_FUNCTIONS = {
  REGULAR: 'REGULAR',
  CYLINDER_BOOST: 'CYLINDER_BOOST',
  HOLIDAY: 'HOLIDAY',
  SYSTEM_OFF: 'SYSTEM_OFF',
};

/** Timeout of a single HTTP call to the platform, in milliseconds. */
export const HTTP_TIMEOUT_MS = 20_000;

/**
 * Build the Keycloak realm of an account: Saunier Duval accounts are always
 * scoped to a country.
 */
export function getRealm(country) {
  return `${BRAND}-${country}-b2c`;
}

/** Root of the read API for a controller family. */
export function getApiBase(controlIdentifier = CONTROL_IDENTIFIERS.TLI) {
  return API_URL_BASE[controlIdentifier] ?? API_URL_BASE[CONTROL_IDENTIFIERS.TLI];
}

/** Root of the endpoints scoped to one system (installation). */
export function getSystemApiBase(systemId, controlIdentifier) {
  const base = getApiBase(controlIdentifier);
  return controlIdentifier === CONTROL_IDENTIFIERS.VRC700
    ? `${base}/systems/${systemId}`
    : `${base}/systems/${systemId}/tli`;
}
