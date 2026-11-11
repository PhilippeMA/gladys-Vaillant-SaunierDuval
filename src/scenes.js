// -----------------------------------------------------------------------------
// Scene actions (SDK v0.14+, Gladys 5.1+).
//
// A scene action is an OPERATION a scene author places in a scene, with
// parameters and a result. Everything that is a plain device command — the
// zone mode, the hot water boost, the ventilation boost — is already reachable
// from a scene through the standard "control a device" action. What is
// declared here is what a device feature cannot express:
//
//   - `start_override`: a temperature AND a duration in one operation, which
//     is how the Saunier Duval application starts a temporary override. A
//     Gladys thermostat control carries a temperature and nothing else;
//   - `cancel_override`: give the zone back to its schedule before the
//     override runs out. No feature carries "the override in progress".
//
// The rules that matter (see the SDK): the `fields` arrive resolved and
// validated by the core; the handler returns the `outputs` declared in the
// manifest; throwing fails this action only, and the scene goes on. An action
// is never a condition: "nothing to do" is an output (`started: false`), not
// an error, so the author of the scene decides what it means.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { getOverrideMinutes, normalizeOverrideMinutes } from './devices/overrideDuration.js';

const logger = createLogger({ name: 'scenes' });

/**
 * Find the zone a scene targets. The `"source": "devices"` select of the scene
 * editor lists every device of the integration, so the boiler or the hot
 * water can be picked by mistake: say so instead of failing obscurely.
 */
function findZone(models, externalId) {
  const model = models.find((candidate) => candidate.externalId === externalId);
  if (!model) {
    throw new Error(`Unknown device "${externalId}": the installation may have changed`);
  }
  if (model.kind !== 'zone') {
    throw new Error(`"${model.device.name}" is not a heating zone`);
  }
  return model;
}

export const SCENE_ACTIONS = {
  /**
   * Override the setpoint of a scheduled zone for a given time.
   * Outputs: `started` — false when the zone has no schedule to go back to
   * (manual mode, or off), in which case nothing is sent.
   */
  async start_override(gladys, { fields, runtime }) {
    // A fresh reading: starting a new override and changing a running one are
    // two different calls, and the choice must not rest on a stale state.
    const zone = findZone(await runtime.getModels({ fresh: true }), fields.zone);
    const temperature = Number(fields.temperature);
    // No duration in the scene: use the one set on the zone itself.
    const minutes =
      normalizeOverrideMinutes(fields.duration) ??
      getOverrideMinutes(zone.externalId, runtime.config);

    if (!zone.info.scheduled) {
      logger.info(`Scene: ${zone.info.name} follows no schedule, no override started`);
      return { started: false };
    }

    logger.info(`Scene: ${zone.info.name} -> ${temperature} °C for ${minutes} min`);
    await runtime.client.setZoneQuickVeto(zone.info.target, temperature, minutes / 60, {
      // The scene states a duration: the clock starts over, even when an
      // override was already running.
      restartDuration: true,
    });
    await runtime.commandApplied(zone.info.features.targetTemperature, temperature);
    return { started: true };
  },

  /**
   * End the override of a zone, which goes back to its schedule.
   * Outputs: `cancelled` — false when no override was running.
   */
  async cancel_override(gladys, { fields, runtime }) {
    const zone = findZone(await runtime.getModels({ fresh: true }), fields.zone);

    if (!zone.info.overrideRunning) {
      logger.info(`Scene: no override running on ${zone.info.name}`);
      return { cancelled: false };
    }

    logger.info(`Scene: ${zone.info.name} -> back to its schedule`);
    await runtime.client.cancelZoneQuickVeto(zone.info.target);
    await runtime.commandApplied();
    return { cancelled: true };
  },
};
