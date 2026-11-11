// -----------------------------------------------------------------------------
// Scene triggers (SDK v0.14+, Gladys 5.1+).
//
// A scene trigger says "this happened". The values of the boiler — a
// temperature, the water pressure, a mode — are device features: a scene
// already reacts to them with the standard "device state" trigger, and
// comparing a value belongs there. What is declared here is what NO feature
// carries as an event:
//   - a fault code appeared on the boiler, with its code and its wording;
//   - the last fault code went away;
//   - the gateway stopped answering the platform, or came back.
//
// An event is a TRANSITION, so the detector compares each reading of the
// installation with the previous one. The first reading only sets the
// baseline: a fault already present when the integration starts is not news,
// and firing it again on every restart would wake people up for nothing.
//
// Both sources live on the slow tier of the client (the fault codes and the
// gateway state are re-read every 30 minutes), so that is how long an event
// can take to fire. The keys below are declared in the manifest
// `scene_triggers` field and are part of the scenes users build: they are
// never renamed.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGERS = {
  FAULT_DETECTED: 'fault_detected',
  FAULTS_CLEARED: 'faults_cleared',
  GATEWAY_OFFLINE: 'gateway_offline',
  GATEWAY_ONLINE: 'gateway_online',
};

/** Every key the integration fires, checked against the manifest in the tests. */
export const SCENE_TRIGGER_KEYS = Object.values(SCENE_TRIGGERS);

/**
 * A boiler failing badly can report a burst of codes at once. The core admits
 * 300 events a minute per integration; a scene sending a notification per
 * event does not need more than a handful to make the point.
 */
const MAX_FAULT_EVENTS_PER_READING = 5;

/**
 * Create the detector. It remembers, per installation, the fault codes and
 * the gateway state of the previous reading.
 */
export function createSceneEventDetector() {
  const known = new Map();

  return {
    /**
     * Compare the boilers of a reading with the previous one.
     *
     * @param {Array} models device models, as built from a snapshot
     * @returns {Array<{ key: string, data: object }>} events to publish
     */
    detect(models) {
      const events = [];

      for (const boiler of models.filter((model) => model.kind === 'boiler')) {
        const { troubleCodes, online } = boiler.info;
        const previous = known.get(boiler.systemId);
        // `device` is the external_id of the boiler device: the value the
        // `"source": "devices"` filter of the trigger stores.
        const device = boiler.externalId;

        // An unknown gateway state is not a transition: keep the last one.
        const current = {
          faultIds: new Set(troubleCodes.map((code) => code.id)),
          online: online ?? previous?.online ?? null,
        };
        known.set(boiler.systemId, current);

        if (!previous) {
          continue;
        }

        const newFaults = troubleCodes.filter((code) => !previous.faultIds.has(code.id));
        for (const fault of newFaults.slice(0, MAX_FAULT_EVENTS_PER_READING)) {
          events.push({
            key: SCENE_TRIGGERS.FAULT_DETECTED,
            data: {
              device,
              code: fault.code,
              title: fault.title,
              description: fault.description,
              kind: fault.kind,
              count: troubleCodes.length,
            },
          });
        }

        if (previous.faultIds.size > 0 && current.faultIds.size === 0) {
          events.push({ key: SCENE_TRIGGERS.FAULTS_CLEARED, data: { device } });
        }

        if (previous.online !== false && current.online === false) {
          events.push({ key: SCENE_TRIGGERS.GATEWAY_OFFLINE, data: { device } });
        }
        if (previous.online === false && current.online === true) {
          events.push({ key: SCENE_TRIGGERS.GATEWAY_ONLINE, data: { device } });
        }
      }

      return events;
    },

    /** Forget the baselines (another account, another installation). */
    reset() {
      known.clear();
    },
  };
}
