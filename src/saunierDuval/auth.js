// -----------------------------------------------------------------------------
// Authentication against the Vaillant Group Keycloak (Saunier Duval realm).
//
// There is no public OAuth client we could redirect a browser to, so we replay
// what the mobile application does:
//   1. start an authorization-code + PKCE flow on the brand/country realm;
//   2. read the login form action URL out of the returned HTML;
//   3. solve the ALTCHA proof of work the page asks for;
//   4. post the credentials, and read the authorization code from the
//      `Location` header of the redirect to the app deep link;
//   5. exchange that code for an access + refresh token.
//
// Keycloak drives the flow with cookies, and Node's `fetch` has no cookie jar,
// so this module keeps a minimal one (identity host only).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { solveAltchaChallenge } from './altcha.js';
import {
  ALTCHA_CHALLENGE_URL,
  AUTHENTICATE_URL,
  CLIENT_ID,
  HTTP_TIMEOUT_MS,
  LOGIN_URL,
  REDIRECT_URI,
  TOKEN_URL,
  getRealm,
} from './const.js';

const logger = createLogger({ name: 'auth' });

/** Renew the token this long before it actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Raised when the platform rejects the credentials: retrying will not help. */
export class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** Minimal cookie jar: enough for the single-host Keycloak dance. */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFromResponse(response) {
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}

/** PKCE pair: a random verifier and its S256 challenge. */
function generatePkcePair() {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/** Decode the handful of HTML entities Keycloak puts in the form action URL. */
function unescapeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Read the `code` query parameter of a redirect Location, whatever its scheme. */
function extractCode(location) {
  const match = /[?&]code=([^&]+)/.exec(location ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

export class VaillantAuth {
  /**
   * @param {{ email: string, password: string, country: string }} credentials
   */
  constructor({ email, password, country }) {
    this.email = email;
    this.password = password;
    this.country = country;
    this.jar = new CookieJar();
    this.session = null; // { accessToken, refreshToken, expiresAt }
    this.pending = null; // in-flight login/refresh, so callers share one round trip
  }

  /** The realm of this account, e.g. `sdbg-france-b2c`. */
  get realm() {
    return getRealm(this.country);
  }

  /** Drop the current session: the next call will log in again. */
  reset() {
    this.session = null;
    this.jar.clear();
  }

  /**
   * Return a valid access token, logging in or refreshing when needed.
   * Concurrent callers share the same in-flight request.
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    if (this.session && this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return this.session.accessToken;
    }
    if (!this.pending) {
      this.pending = this.#renew().finally(() => {
        this.pending = null;
      });
    }
    await this.pending;
    return this.session.accessToken;
  }

  /** Refresh when we can, log in from scratch otherwise. */
  async #renew() {
    if (this.session?.refreshToken) {
      try {
        this.session = await this.#refresh(this.session.refreshToken);
        logger.debug('Access token refreshed');
        return;
      } catch (err) {
        logger.info('Token refresh failed, logging in again', err.message);
      }
    }
    this.jar.clear();
    this.session = await this.#login();
    logger.info(`Logged in on realm ${this.realm}`);
  }

  /** Full authorization-code + PKCE login. */
  async #login() {
    if (!this.email || !this.password) {
      throw new AuthenticationError('Email and password are required');
    }
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const code = await this.#getAuthorizationCode(codeChallenge);
    return this.#exchangeCode(code, codeVerifier);
  }

  /** Steps 1 to 4: from the authorize endpoint to the authorization code. */
  async #getAuthorizationCode(codeChallenge) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      code: 'code_challenge',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
    });
    const authorizeUrl = `${AUTHENTICATE_URL.replace('{realm}', this.realm)}?${query}`;

    const authorizeResponse = await this.#fetch(authorizeUrl);
    this.jar.storeFromResponse(authorizeResponse);

    // A still-valid Keycloak session answers with the code right away.
    const shortcut = extractCode(authorizeResponse.headers.get('location'));
    if (shortcut) {
      return shortcut;
    }
    if (authorizeResponse.status >= 400) {
      throw new AuthenticationError(
        `The login page answered HTTP ${authorizeResponse.status}. Check the country of the account (realm ${this.realm}).`,
      );
    }

    const html = await authorizeResponse.text();
    const loginUrlMatch = new RegExp(
      `${LOGIN_URL.replace('{realm}', this.realm).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?[^"]*`,
    ).exec(html);
    if (!loginUrlMatch) {
      throw new AuthenticationError('Could not find the login form URL in the login page');
    }
    const loginUrl = unescapeHtml(loginUrlMatch[0]);

    const form = new URLSearchParams({
      username: this.email,
      password: this.password,
      credentialId: '',
    });

    const altcha = await this.#solveAltcha();
    if (altcha) {
      form.set('altcha', altcha);
    }

    const loginResponse = await this.#fetch(loginUrl, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    this.jar.storeFromResponse(loginResponse);

    const code = extractCode(loginResponse.headers.get('location'));
    if (!code) {
      // Keycloak re-renders the form (HTTP 200) when the credentials are wrong.
      throw new AuthenticationError(
        'Login refused by Saunier Duval: check the email, the password and the country of the account.',
      );
    }
    return code;
  }

  /** Step 3: the proof of work. Non-blocking if the endpoint is unavailable. */
  async #solveAltcha() {
    try {
      const response = await this.#fetch(ALTCHA_CHALLENGE_URL);
      if (!response.ok) {
        return null;
      }
      return await solveAltchaChallenge(await response.json());
    } catch (err) {
      logger.debug('ALTCHA challenge skipped', err.message);
      return null;
    }
  }

  /** Step 5: authorization code -> tokens. */
  async #exchangeCode(code, codeVerifier) {
    return this.#token({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    });
  }

  async #refresh(refreshToken) {
    return this.#token({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });
  }

  async #token(payload) {
    const response = await this.#fetch(TOKEN_URL.replace('{realm}', this.realm), {
      method: 'POST',
      body: new URLSearchParams(payload),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new AuthenticationError(
        `Token endpoint answered HTTP ${response.status}: ${body.error_description ?? body.error ?? 'unknown error'}`,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
    };
  }

  /** Every auth request: manual redirects (we read them) + our cookie jar. */
  async #fetch(url, options = {}) {
    const cookie = this.jar.header();
    return fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...options,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
    });
  }
}
