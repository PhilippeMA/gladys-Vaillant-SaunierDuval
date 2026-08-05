// -----------------------------------------------------------------------------
// Minimal cookie jar.
//
// Node's global `fetch` is stateless: it never stores nor replays cookies. The
// Keycloak login flow needs them — the authorization request opens a session
// (AUTH_SESSION_ID, KC_RESTART…) and the credentials POST is only accepted if
// it carries those cookies back. So we keep a tiny jar for the duration of a
// login.
//
// Deliberately simple: the jar is used against a single host
// (identity.vaillant-group.com) over one short-lived login sequence, so it
// ignores Domain/Path/Secure scoping and only implements what the flow needs —
// storing, replacing and expiring cookies by name.
// -----------------------------------------------------------------------------

export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} cookie name -> value */
    this.cookies = new Map();
  }

  /**
   * Store the cookies of a response, honouring deletions.
   * @param {Response} response - A fetch Response.
   */
  storeFromResponse(response) {
    // getSetCookie() returns each Set-Cookie header separately (Node 19.7+);
    // a plain headers.get() would join them into one unparseable string.
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const separator = pair.indexOf('=');
      if (separator < 1) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();

      if (isDeletion(value, attributes)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Build the `Cookie` request header.
   * @returns {string} The header value, empty when the jar is empty.
   */
  toHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/**
 * Detect the "delete this cookie" form: an empty value, `Max-Age=0` or a past
 * expiry date.
 * @param {string} value - Cookie value.
 * @param {string[]} attributes - Raw attributes of the Set-Cookie header.
 * @returns {boolean} True when the cookie must be dropped.
 */
function isDeletion(value, attributes) {
  if (value === '') {
    return true;
  }
  for (const attribute of attributes) {
    const [rawName, ...rest] = attribute.split('=');
    const name = rawName.trim().toLowerCase();
    const attributeValue = rest.join('=').trim();

    if (name === 'max-age' && Number(attributeValue) <= 0) {
      return true;
    }
    if (name === 'expires') {
      const expires = Date.parse(attributeValue);
      if (!Number.isNaN(expires) && expires <= Date.now()) {
        return true;
      }
    }
  }
  return false;
}
