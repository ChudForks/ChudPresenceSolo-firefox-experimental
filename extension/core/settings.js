import { normalizeActivityPreferences } from './activity-settings.js';
import { DISCORD_CLIENT_ID } from '../config.js';

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

export function presenceDetailsForTrack(track, settings = DEFAULT_SETTINGS, activityPreferences = null) {
  if (activityPreferences) {
    const preferences = normalizeActivityPreferences(activityPreferences);
    return {
      statusDisplay: preferences.statusDisplay,
      showArtwork: preferences.showArtwork,
      showTimestamps: preferences.showTimestamps,
      showButtons: preferences.showButtons,
    };
  }
  const keys = track?.settingKeys;
  if (!keys) return {};
  const current = normalizeSettings(settings);
  return {
    ...(keys.statusDisplay ? { statusDisplay: current[keys.statusDisplay] } : {}),
    ...(keys.showArtwork ? { showArtwork: current[keys.showArtwork] } : {}),
    ...(keys.showTimestamps ? { showTimestamps: current[keys.showTimestamps] } : {}),
    ...(keys.showButtons ? { showButtons: current[keys.showButtons] } : {}),
  };
}

export function applicationIdForPresence() {
  return DISCORD_CLIENT_ID;
}

export function isTrackAllowed(track, settings = DEFAULT_SETTINGS, activityPreferences = null) {
  if (!track) return false;
  const current = normalizeSettings(settings);
  if (!current.enabled) return false;
  if (track.media && track.playback) {
    return track.playback.state === 'playing' || normalizeActivityPreferences(activityPreferences).showPaused;
  }
  if (track.activityId) {
    return track.playing || normalizeActivityPreferences(activityPreferences).showPaused;
  }
  const keys = track.settingKeys;
  if (!keys) return true;
  if (keys.enabled && !current[keys.enabled]) return false;
  return track.playing || !keys.showPaused || current[keys.showPaused];
}
