// -----------------------------------------------------------------------------
// Authentication against the Vaillant Group identity provider (Keycloak).
//
// The myVAILLANT / MiGo mobile app uses a standard OAuth2 authorization-code
// flow with PKCE, but its redirect URI is a mobile deep link
// (`enduservaillant.page.link://login`) that a server cannot receive. There is
// no documented client-credentials or password grant either, so — like every
// community implementation of this API — we drive the login form ourselves:
//
//   1. start the PKCE flow on the authorization endpoint and keep the session
//      cookies Keycloak sets;
//   2. read the form action out of the returned login page;
//   3. solve the ALTCHA proof of work the page embeds;
//   4. post the credentials: Keycloak answers 302 to the deep link, carrying
//      the authorization code in the query string;
//   5. exchange that code for an access + refresh token.
//
// Steps 2-4 depend on the HTML Keycloak serves, so they are the fragile part of
// this integration: a redesign of the login page breaks them, and the errors
// below are worded to make that obvious in the logs.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import {
  ALTCHA_CHALLENGE_URL,
  AUTHORIZE_URL,
  CLIENT_ID,
  LOGIN_URL,
  REDIRECT_URI,
  TOKEN_URL,
  getRealm,
} from './constants.js';
import { CookieJar } from './cookieJar.js';
import { solveAltchaChallenge } from './altcha.js';

const logger = createLogger({ name: 'saunier-duval-auth' });

const REQUEST_TIMEOUT_MS = 20_000;

/** Raised when the credentials or the country are wrong: retrying will not help. */
export class AuthenticationFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationFailedError';
  }
}

/**
 * Log in with a username and a password, and return an OAuth2 session.
 * @param {object} credentials - The account to log in with.
 * @param {string} credentials.username - Account email address.
 * @param {string} credentials.password - Account password.
 * @param {string} credentials.country - Country key, e.g. 'france'.
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>} The token set.
 */
export async function login({ username, password, country }) {
  const realm = getRealm(country);
  const jar = new CookieJar();
  const { codeVerifier, codeChallenge } = generateCodeChallenge();

  const code = await getAuthorizationCode({ realm, jar, codeChallenge, username, password });
  return exchangeCodeForToken({ realm, code, codeVerifier });
}

/**
 * Exchange a refresh token for a fresh token set.
 * @param {object} session - The current session.
 * @param {string} session.refreshToken - The refresh token.
 * @param {string} session.country - Country key, e.g. 'france'.
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>} The new token set.
 */
export async function refreshToken({ refreshToken: token, country }) {
  const response = await fetch(TOKEN_URL.replace('{realm}', getRealm(country)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: token,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // A rejected refresh token is not recoverable by retrying: the caller
    // falls back to a full login.
    throw new AuthenticationFailedError(
      `Token refresh rejected with HTTP ${response.status}, a new login is required`,
    );
  }
  return response.json();
}

/**
 * Run the interactive part of the flow: authorization request, login form,
 * ALTCHA challenge, credentials POST.
 * @param {object} options - Flow inputs.
 * @param {string} options.realm - Keycloak realm.
 * @param {CookieJar} options.jar - Jar carrying the Keycloak session cookies.
 * @param {string} options.codeChallenge - PKCE S256 challenge.
 * @param {string} options.username - Account email address.
 * @param {string} options.password - Account password.
 * @returns {Promise<string>} The authorization code.
 */
async function getAuthorizationCode({ realm, jar, codeChallenge, username, password }) {
  const authorizeUrl = `${AUTHORIZE_URL.replace('{realm}', realm)}?${new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    code: 'code_challenge',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  })}`;

  const authorizeResponse = await jarFetch(jar, authorizeUrl);

  // An already-authenticated session would redirect straight to the deep link.
  const immediateCode = extractCode(authorizeResponse.headers.get('location'));
  if (immediateCode) {
    return immediateCode;
  }

  if (authorizeResponse.status === 404) {
    throw new AuthenticationFailedError(
      `Unknown Keycloak realm "${realm}": check the country of the Saunier Duval account`,
    );
  }

  const loginUrl = extractLoginUrl(await authorizeResponse.text(), realm);
  if (!loginUrl) {
    throw new AuthenticationFailedError(
      'Could not find the login form in the Saunier Duval login page (the page layout may have changed)',
    );
  }

  const form = new URLSearchParams({ username, password, credentialId: '' });
  const altcha = await solveAltcha(jar);
  if (altcha) {
    form.set('altcha', altcha);
  }

  const loginResponse = await jarFetch(jar, loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  const code = extractCode(loginResponse.headers.get('location'));
  if (!code) {
    // Keycloak re-renders the form (HTTP 200) instead of redirecting when the
    // credentials are refused.
    throw new AuthenticationFailedError(
      'Login refused by Saunier Duval: check the email address and the password of the MiGo account',
    );
  }
  return code;
}

/**
 * Exchange the authorization code for tokens.
 * @param {object} options - Exchange inputs.
 * @param {string} options.realm - Keycloak realm.
 * @param {string} options.code - Authorization code.
 * @param {string} options.codeVerifier - PKCE verifier matching the challenge.
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>} The token set.
 */
async function exchangeCodeForToken({ realm, code, codeVerifier }) {
  const response = await fetch(TOKEN_URL.replace('{realm}', realm), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new AuthenticationFailedError(
      `Token exchange failed with HTTP ${response.status} on the Saunier Duval identity provider`,
    );
  }
  return response.json();
}

/**
 * Fetch the ALTCHA challenge and solve it. The widget is not always served, so
 * a failure here is not fatal: we simply post the form without the field.
 * @param {CookieJar} jar - Jar carrying the Keycloak session cookies.
 * @returns {Promise<string|null>} The `altcha` form value, or null.
 */
async function solveAltcha(jar) {
  try {
    const response = await jarFetch(jar, ALTCHA_CHALLENGE_URL);
    if (!response.ok) {
      return null;
    }
    return await solveAltchaChallenge(await response.json());
  } catch (err) {
    logger.debug('Could not fetch or solve the ALTCHA challenge, continuing without it', err);
    return null;
  }
}

/**
 * Fetch that replays and stores cookies, and never follows redirects (the flow
 * reads the Location headers itself).
 * @param {CookieJar} jar - The cookie jar.
 * @param {string} url - URL to fetch.
 * @param {object} [options] - Extra fetch options.
 * @returns {Promise<Response>} The response.
 */
async function jarFetch(jar, url, options = {}) {
  const cookie = jar.toHeader();
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    headers: {
      // The backend rejects unknown clients, so we present ourselves as the
      // mobile app does.
      'User-Agent': 'okhttp/4.9.2',
      Accept: 'text/html,application/json,*/*',
      ...options.headers,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  jar.storeFromResponse(response);
  return response;
}

/**
 * Generate a PKCE verifier and its S256 challenge.
 * @returns {{codeVerifier: string, codeChallenge: string}} The PKCE pair.
 */
export function generateCodeChallenge() {
  // 96 random bytes -> 128 base64url characters, the maximum length RFC 7636
  // allows for a verifier.
  const codeVerifier = randomBytes(96).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Read the `code` query parameter out of a redirect target. The Location is a
 * custom-scheme deep link, so it is parsed as a raw query string rather than
 * with `new URL()`.
 * @param {string|null} location - Value of the Location header.
 * @returns {string|null} The authorization code, or null.
 */
export function extractCode(location) {
  if (!location) {
    return null;
  }
  const queryStart = location.indexOf('?');
  if (queryStart === -1) {
    return null;
  }
  return new URLSearchParams(location.slice(queryStart + 1)).get('code');
}

/**
 * Extract the action URL of the login form from the Keycloak login page.
 * @param {string} html - HTML of the login page.
 * @param {string} realm - Keycloak realm.
 * @returns {string|null} The absolute form action URL, or null.
 */
export function extractLoginUrl(html, realm) {
  const base = LOGIN_URL.replace('{realm}', realm);
  const pattern = new RegExp(`${escapeRegExp(base)}\\?[^"']*`);
  const match = html.match(pattern);
  return match ? unescapeHtml(match[0]) : null;
}

/**
 * Escape a string for literal use inside a regular expression.
 * @param {string} value - The string.
 * @returns {string} The escaped string.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decode the few HTML entities Keycloak puts in a form action (`&amp;` mostly).
 * @param {string} value - The escaped string.
 * @returns {string} The decoded string.
 */
function unescapeHtml(value) {
  return value
    .replace(/&(?:amp|#38|#x26);/gi, '&')
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:lt|#60|#x3c);/gi, '<')
    .replace(/&(?:gt|#62|#x3e);/gi, '>');
}
