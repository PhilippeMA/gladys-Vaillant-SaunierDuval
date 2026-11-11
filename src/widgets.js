// -----------------------------------------------------------------------------
// Dashboard widget (SDK v0.14+, Gladys 5.1+).
//
// One card for the whole installation: the temperatures that matter, the
// state of each zone, the gateway, the faults, and the two boosts. The content
// is declarative — tiles, a status list, buttons — and rendered by the core
// with its own theme: no HTML here.
//
// Three choices worth knowing:
//
//   - The content NEVER costs a call to Saunier Duval. It is built from the
//     last reading of the refresh loop, however many dashboards are open, and
//     the loop nudges the widget after each cycle (`refreshWidgets`).
//   - The values are computed rather than bound to device features, so the
//     card is complete whichever devices the user chose to create in Gladys.
//   - The wording is ours: where the thermostat control can only show the
//     vocabulary of Gladys ("Heating", "Auto"), the card uses the words of the
//     Saunier Duval application (manual, schedule, off).
//
// The content budget of a card is 8 components (6 tiles, 1 status list,
// 4 buttons at most): what does not fit is dropped by the core in content
// order, so the builder below counts.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS, createLogger } from '@gladysassistant/integration-sdk';
import { findCommand } from './devices/index.js';
import { THERMOSTAT_MODE } from './devices/mappings.js';

const logger = createLogger({ name: 'widgets' });

/** Widget key, as declared in the manifest `widgets` field. Never renamed. */
export const BOILER_WIDGET = 'boiler';

/** Keys of the `button` actions the content declares. */
export const BOILER_WIDGET_ACTIONS = {
  HOT_WATER_BOOST: 'hot_water_boost',
  VENTILATION_BOOST: 'ventilation_boost',
  REFRESH: 'refresh',
};

/** Tiles kept on the card: with the status list and 3 buttons, that makes 8. */
const MAX_TILES = 4;
const MAX_ZONE_TILES = 2;
const MAX_ZONE_ROWS = 4;

/** The pressure under which a heating circuit wants a top-up, in bar. */
const LOW_PRESSURE_BAR = 1;
const CRITICAL_PRESSURE_BAR = 0.6;

const ACTIVITY_LABELS = {
  HEATING: { en: 'Heating', fr: 'Chauffage' },
  DHW: { en: 'Hot water', fr: 'Eau chaude' },
  COOLING: { en: 'Cooling', fr: 'Rafraîchissement' },
  STANDBY: { en: 'Standby', fr: 'Veille' },
  OFF: { en: 'Off', fr: 'Arrêt' },
};

/** The modes, in the words of the Saunier Duval application. */
const MODE_LABELS = {
  [THERMOSTAT_MODE.HEATING]: { en: 'Manual', fr: 'Manuel' },
  [THERMOSTAT_MODE.AUTO]: { en: 'Schedule', fr: 'Programmation' },
  [THERMOSTAT_MODE.OFF]: { en: 'Off', fr: 'Arrêt' },
};

/** Texts of a card are capped by the core; cut ours rather than let it. */
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Apply the same suffix to both languages of a text. */
const withSuffix = (text, suffix) => ({ en: `${text.en}${suffix}`, fr: `${text.fr}${suffix}` });

/**
 * The devices of the installation a card shows: the one of the device chosen
 * in the widget settings (any device of the installation will do), or the
 * first one — nearly every account has a single boiler.
 */
function modelsOfInstallation(models, settings) {
  const chosen = models.find((model) => model.externalId === settings?.device);
  const systemId = chosen?.systemId ?? models.find((model) => model.kind === 'boiler')?.systemId;
  return models.filter((model) => model.systemId === systemId);
}

function temperatureTile(label, value, icon, color = WIDGET_COLORS.NEUTRAL) {
  return { type: 'value', label, value, unit: '°C', icon, color };
}

function pressureColor(pressure) {
  if (pressure < CRITICAL_PRESSURE_BAR) {
    return WIDGET_COLORS.DANGER;
  }
  return pressure < LOW_PRESSURE_BAR ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS;
}

/** "Schedule · 21 °C", "Manual · 19.5 °C (override)", "Off". */
function zoneStatus(zone) {
  const mode = MODE_LABELS[zone.mode] ?? { en: 'Unknown', fr: 'Inconnu' };
  if (zone.mode === THERMOSTAT_MODE.OFF || zone.targetTemperature === null) {
    return mode;
  }
  const setpoint = withSuffix(mode, ` · ${zone.targetTemperature} °C`);
  return zone.overrideRunning
    ? { en: `${setpoint.en} (override)`, fr: `${setpoint.fr} (forçage)` }
    : setpoint;
}

function faultStatus(troubleCodes) {
  if (troubleCodes.length === 0) {
    return { value: { en: 'None', fr: 'Aucun' }, color: WIDGET_COLORS.SUCCESS };
  }
  const [first] = troubleCodes;
  const wording = [first.code, first.title].filter(Boolean).join(' ') || '?';
  const more = troubleCodes.length > 1 ? ` (+${troubleCodes.length - 1})` : '';
  return { value: cut(`${wording}${more}`, 40), color: WIDGET_COLORS.DANGER };
}

function boostButton(actionKey, feature, running, labels, icon) {
  return {
    type: 'button',
    label: running ? labels.stop : labels.start,
    icon,
    style: running ? 'danger' : 'secondary',
    // `params` are declared here and sent back as they are: the handler never
    // receives user input, a dashboard can hang on a wall.
    action: { key: actionKey, params: { feature, value: running ? 0 : 1 } },
  };
}

/** What a card says when there is nothing to show yet. */
function emptyContent(text) {
  return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text }] };
}

/**
 * Build the content of the card from the device models of a reading.
 * Pure, and exported for the tests: `validateWidgetContent` checks it there.
 *
 * @param {Array} models device models of the last reading
 * @param {{ settings?: object, config: object }} options
 */
export function buildBoilerContent(models, { settings, config }) {
  const installation = modelsOfInstallation(models, settings);
  const boiler = installation.find((model) => model.kind === 'boiler');
  if (!boiler) {
    return emptyContent({
      en: 'No boiler read yet. Check the configuration of the integration.',
      fr: "Aucune chaudière lue pour l'instant. Vérifiez la configuration de l'intégration.",
    });
  }
  const zones = installation.filter((model) => model.kind === 'zone').map((model) => model.info);
  const hotWater = installation.find((model) => model.kind === 'hot-water')?.info;
  const { info } = boiler;

  // --- Tiles, by decreasing interest: rooms, hot water, pressure, outdoor.
  const tiles = [
    ...zones
      .filter((zone) => zone.temperature !== null)
      .slice(0, MAX_ZONE_TILES)
      .map((zone) =>
        temperatureTile(
          cut(zone.name, 24),
          zone.temperature,
          'thermometer',
          zone.heating ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
        ),
      ),
    ...(hotWater && hotWater.temperature !== null
      ? [temperatureTile({ en: 'Hot water', fr: 'Eau chaude' }, hotWater.temperature, 'droplet')]
      : []),
    ...(info.waterPressure !== null
      ? [
          {
            type: 'value',
            label: { en: 'Pressure', fr: 'Pression' },
            value: info.waterPressure,
            unit: 'bar',
            icon: 'activity',
            color: pressureColor(info.waterPressure),
          },
        ]
      : []),
    ...(info.outdoorTemperature !== null
      ? [temperatureTile({ en: 'Outdoor', fr: 'Extérieur' }, info.outdoorTemperature, 'cloud')]
      : []),
  ].slice(0, MAX_TILES);

  // --- Status list: what the installation is doing, zone by zone.
  const items = [
    {
      label: cut(info.name, 40),
      icon: 'zap',
      value: ACTIVITY_LABELS[info.activity] ?? { en: 'Unknown', fr: 'Inconnu' },
      color:
        info.activity === 'HEATING' || info.activity === 'DHW'
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.NEUTRAL,
    },
    ...zones.slice(0, MAX_ZONE_ROWS).map((zone) => ({
      label: cut(zone.name, 40),
      icon: 'sliders',
      value: zoneStatus(zone),
      color: zone.heating ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    })),
    // The platform does not always say: no row rather than a guess.
    ...(info.online === null
      ? []
      : [
          {
            label: { en: 'Gateway', fr: 'Passerelle' },
            icon: 'wifi',
            value: info.online
              ? { en: 'Online', fr: 'En ligne' }
              : { en: 'Offline', fr: 'Hors ligne' },
            color: info.online ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
          },
        ]),
    {
      label: { en: 'Faults', fr: 'Défauts' },
      icon: 'alert-triangle',
      ...faultStatus(info.troubleCodes),
    },
  ];

  // --- Buttons: the two boosts, and a reading on demand.
  const buttons = [
    ...(hotWater
      ? [
          boostButton(
            BOILER_WIDGET_ACTIONS.HOT_WATER_BOOST,
            hotWater.features.boost,
            hotWater.boosting,
            {
              start: { en: 'Hot water boost', fr: 'Boost eau chaude' },
              stop: { en: 'Stop hot water boost', fr: 'Arrêter le boost ECS' },
            },
            'droplet',
          ),
        ]
      : []),
    boostButton(
      BOILER_WIDGET_ACTIONS.VENTILATION_BOOST,
      info.features.ventilationBoost,
      info.ventilationBoost,
      {
        start: { en: 'Ventilation boost', fr: 'Boost ventilation' },
        stop: { en: 'Stop ventilation', fr: 'Arrêter ventilation' },
      },
      'wind',
    ),
    {
      type: 'button',
      label: { en: 'Refresh', fr: 'Actualiser' },
      icon: 'refresh-cw',
      style: 'secondary',
      action: { key: BOILER_WIDGET_ACTIONS.REFRESH },
    },
  ];

  return {
    // The loop nudges the card after every reading: the TTL is the safety net,
    // set on the refresh interval itself (the core accepts 10 to 3600 s).
    ttl_seconds: Math.min(Math.max(config.poll_frequency, 10), 3600),
    components: [...tiles, { type: 'status', items }, ...buttons],
  };
}

export const WIDGETS = {
  [BOILER_WIDGET]: {
    async get(gladys, { settings, runtime }) {
      logger.debug(`onWidgetGet <- ${BOILER_WIDGET}`);
      if (!runtime.isConfigured()) {
        return emptyContent({
          en: 'Enter your MiGo / MiGo Link account in the integration configuration.',
          fr: "Renseignez votre compte MiGo / MiGo Link dans la configuration de l'intégration.",
        });
      }
      return buildBoilerContent(await runtime.getLatestModels(), {
        settings,
        config: runtime.config,
      });
    },

    // The resolved text is shown as a toast. After a successful action the core
    // drops its cached content and the open dashboards fetch it again.
    async action(gladys, { actionKey, params, runtime }) {
      logger.info(`onWidgetAction <- ${BOILER_WIDGET}.${actionKey}`);

      if (actionKey === BOILER_WIDGET_ACTIONS.REFRESH) {
        await runtime.refresh();
        return { en: 'Boiler read.', fr: 'Chaudière relue.' };
      }

      if (
        actionKey === BOILER_WIDGET_ACTIONS.HOT_WATER_BOOST ||
        actionKey === BOILER_WIDGET_ACTIONS.VENTILATION_BOOST
      ) {
        // The params come back from our own content, but a card can outlive
        // the installation it was built for: only run a command that exists.
        if (!findCommand(await runtime.getLatestModels(), params?.feature)) {
          throw new Error('This installation is no longer available, refresh the dashboard');
        }
        await runtime.runCommand(params.feature, params.value === 1 ? 1 : 0);
        return params.value === 1
          ? { en: 'Boost requested.', fr: 'Boost demandé.' }
          : { en: 'Boost stopped.', fr: 'Boost arrêté.' };
      }

      // Throwing acks the action as failed: the message reaches the user.
      throw new Error(`Unknown widget action: ${actionKey}`);
    },
  },
};

/**
 * Ask the core to pull every widget again now instead of waiting for the TTL.
 * Fire-and-forget: rate-limited core-side (1 per 10 s per widget) and dropped
 * while disconnected, which is why it is also sent after each reconnection.
 */
export function refreshWidgets(gladys) {
  for (const key of Object.keys(WIDGETS)) {
    gladys.requestWidgetRefresh(key);
  }
}
