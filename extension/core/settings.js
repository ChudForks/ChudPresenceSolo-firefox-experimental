import { SERVICE_APPLICATION_IDS } from '../config.js';
import { normalizeActivityPreferences } from './activity-settings.js';

export const SERVICE_SETTINGS = Object.freeze({
  youtube: Object.freeze({
    label: 'YouTube',
    enabled: 'sourceYouTube',
    paused: 'youtubeShowPaused',
    status: 'youtubeStatusDisplay',
    statusValues: Object.freeze(['app', 'creator', 'video']),
    artwork: 'youtubeShowArtwork',
    timestamps: 'youtubeShowTimestamps',
    buttons: 'youtubeShowButtons',
  }),
  movies67: Object.freeze({
    label: '67Movies',
    enabled: 'sourceMovies67',
    paused: 'movies67ShowPaused',
    status: 'movies67StatusDisplay',
    statusValues: Object.freeze(['app', 'series', 'episode']),
    artwork: 'movies67ShowArtwork',
    timestamps: 'movies67ShowTimestamps',
    buttons: 'movies67ShowButtons',
  }),
  twitch: Object.freeze({
    label: 'Twitch',
    enabled: 'sourceTwitch',
    paused: 'twitchShowPaused',
    status: 'twitchStatusDisplay',
    statusValues: Object.freeze(['app', 'streamer', 'stream']),
    artwork: 'twitchShowArtwork',
    timestamps: 'twitchShowTimestamps',
    buttons: 'twitchShowButtons',
  }),
  kick: Object.freeze({
    label: 'Kick',
    enabled: 'sourceKick',
    paused: 'kickShowPaused',
    status: 'kickStatusDisplay',
    statusValues: Object.freeze(['app', 'streamer', 'stream']),
    artwork: 'kickShowArtwork',
    timestamps: 'kickShowTimestamps',
    buttons: 'kickShowButtons',
  }),
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  sourceYouTube: true,
  youtubeShowPaused: true,
  youtubeStatusDisplay: 'app',
  youtubeShowArtwork: true,
  youtubeShowTimestamps: true,
  youtubeShowButtons: true,
  sourceMovies67: true,
  movies67ShowPaused: true,
  movies67StatusDisplay: 'app',
  movies67ShowArtwork: true,
  movies67ShowTimestamps: true,
  movies67ShowButtons: true,
  sourceTwitch: true,
  twitchShowPaused: true,
  twitchStatusDisplay: 'app',
  twitchShowArtwork: true,
  twitchShowTimestamps: true,
  twitchShowButtons: true,
  sourceKick: true,
  kickShowPaused: true,
  kickStatusDisplay: 'app',
  kickShowArtwork: true,
  kickShowTimestamps: true,
  kickShowButtons: true,
});

export const LEGACY_DETAIL_SETTINGS = Object.freeze([
  'showPaused',
  'showArtwork',
  'showTimestamps',
  'showButtons',
]);

export const LEGACY_APPLICATION_ID_SETTINGS = Object.freeze([
  'youtubeApplicationId',
  'crunchyrollApplicationId',
  'movies67ApplicationId',
  'twitchApplicationId',
  'kickApplicationId',
]);

export function normalizeSettings(value = {}) {
  const normalized = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof fallback === 'boolean') {
      normalized[key] = typeof value[key] === 'boolean' ? value[key] : fallback;
    } else {
      normalized[key] = typeof value[key] === 'string' ? value[key].trim() : fallback;
    }
  }

  for (const service of Object.values(SERVICE_SETTINGS)) {
    if (typeof value[service.paused] !== 'boolean' && typeof value.showPaused === 'boolean') {
      normalized[service.paused] = value.showPaused;
    }
    if (typeof value[service.artwork] !== 'boolean' && typeof value.showArtwork === 'boolean') {
      normalized[service.artwork] = value.showArtwork;
    }
    if (typeof value[service.timestamps] !== 'boolean' && typeof value.showTimestamps === 'boolean') {
      normalized[service.timestamps] = value.showTimestamps;
    }
    if (typeof value[service.buttons] !== 'boolean' && typeof value.showButtons === 'boolean') {
      normalized[service.buttons] = value.showButtons;
    }
    if (!service.statusValues.includes(value[service.status])) {
      normalized[service.status] = DEFAULT_SETTINGS[service.status];
    }
  }
  return normalized;
}

export function presenceDetailsForSource(source, settings = DEFAULT_SETTINGS, activityPreferences = null) {
  if (activityPreferences) {
    const preferences = normalizeActivityPreferences(activityPreferences);
    return {
      statusDisplay: preferences.statusDisplay,
      showArtwork: preferences.showArtwork,
      showTimestamps: preferences.showTimestamps,
      showButtons: preferences.showButtons,
    };
  }
  const service = SERVICE_SETTINGS[source];
  if (!service) return {};
  const current = normalizeSettings(settings);
  return {
    statusDisplay: current[service.status],
    showArtwork: current[service.artwork],
    showTimestamps: current[service.timestamps],
    showButtons: current[service.buttons],
  };
}

export function applicationIdForSource(source) {
  return SERVICE_APPLICATION_IDS[source] || SERVICE_APPLICATION_IDS.youtube || '';
}

export function isTrackAllowed(track, settings = DEFAULT_SETTINGS, activityPreferences = null) {
  if (!track) return false;
  const current = normalizeSettings(settings);
  if (!current.enabled) return false;
  if (track.activityId) {
    return track.playing || normalizeActivityPreferences(activityPreferences).showPaused;
  }
  const service = SERVICE_SETTINGS[track.source];
  if (!service) return true;
  if (!current[service.enabled]) return false;
  return track.playing || current[service.paused];
}
