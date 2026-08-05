// -----------------------------------------------------------------------------
// Handlers of the manifest `actions`: the buttons rendered in the Gladys
// Configuration screen. The message they resolve is displayed under the button
// (a thrown error is displayed too), so they are the place to answer the
// question a cloud integration always raises: "are my credentials right, and
// what does Gladys see on my account?".
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'actions' });

/**
 * Log in, read the account, and describe what was found.
 * @param {object} client - The API client.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function testConnection(client) {
  logger.info('Action test_connection -> live call to the Saunier Duval cloud');
  // A diagnostic must not answer from any cache, including the installations.
  const systems = await client.getSystems({ force: true, refreshHomes: true });

  if (systems.length === 0) {
    return {
      en: 'Connected, but no heating installation is attached to this account.',
      fr: "Connexion réussie, mais aucune installation de chauffage n'est rattachée à ce compte.",
    };
  }

  const summary = systems
    .map((system) => {
      const zones = system.zones
        .filter((zone) => zone.isActive)
        .map((zone) => `${zone.name} ${formatTemperature(zone.currentTemperature)}`)
        .join(', ');
      return `${system.name} (${formatTemperature(system.outdoorTemperature)} outside) - ${zones}`;
    })
    .join(' | ');

  return {
    en: `Connected. ${systems.length} installation(s): ${summary}`,
    fr: `Connexion réussie. ${systems.length} installation(s) : ${summary}`,
  };
}

/**
 * Render a temperature, or a dash when the gateway reported none.
 * @param {number|null} value - Temperature in Celsius.
 * @returns {string} The formatted temperature.
 */
function formatTemperature(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}°C`;
}
