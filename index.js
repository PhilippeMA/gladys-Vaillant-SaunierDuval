// -----------------------------------------------------------------------------
// Entry point of the Saunier Duval integration for Gladys Assistant.
//
// Nothing happens here but the start: the integration itself is in src/app.js,
// where the tests can run it against a fake Gladys.
//
// Environment variables injected by the Gladys supervisor into the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them by itself: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const gladys = new GladysIntegration();

// Handlers are registered before connect(), as the SDK requires.
createApp(gladys);

logger.info('Starting the Saunier Duval integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
