import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationIdForPresence,
  DEFAULT_SETTINGS,
  isTrackAllowed,
  normalizeSettings,
  presenceDetailsForTrack,
} from '../extension/core/settings.js';
import { DISCORD_CLIENT_ID } from '../extension/config.js';

test('normalizes missing and invalid settings to defaults', () => {
  assert.deepEqual(normalizeSettings({ enabled: false, showArtwork: 'no' }), {
    ...DEFAULT_SETTINGS,
    enabled: false,
  });
});

test('filters disabled sources', () => {
  assert.equal(isTrackAllowed({
    source: 'youtube', playing: true, settingKeys: { enabled: 'sourceYouTube' },
  }, {
    ...DEFAULT_SETTINGS,
    sourceYouTube: false,
  }), false);
  assert.equal(isTrackAllowed({ source: 'crunchyroll', activityId: 'crunchyroll', playing: true }, DEFAULT_SETTINGS), true);
});

test('filters paused tracks only when configured', () => {
  const paused = { source: 'crunchyroll', activityId: 'crunchyroll', playing: false };
  assert.equal(isTrackAllowed(paused, DEFAULT_SETTINGS, { showPaused: true }), true);
  assert.equal(isTrackAllowed(paused, DEFAULT_SETTINGS, { showPaused: false }), false);
});

test('migrates legacy global presence preferences to every service', () => {
  const normalized = normalizeSettings({
    showPaused: false,
    showArtwork: false,
    showTimestamps: true,
    showButtons: false,
  });

  for (const prefix of ['youtube', 'movies67', 'twitch', 'kick']) {
    assert.equal(normalized[`${prefix}ShowPaused`], false);
    assert.equal(normalized[`${prefix}ShowArtwork`], false);
    assert.equal(normalized[`${prefix}ShowTimestamps`], true);
    assert.equal(normalized[`${prefix}ShowButtons`], false);
  }
});

test('uses generic track settings and one fixed Discord application identity', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    youtubeShowArtwork: false,
  };
  const track = { settingKeys: {
    statusDisplay: 'youtubeStatusDisplay', showArtwork: 'youtubeShowArtwork',
    showTimestamps: 'youtubeShowTimestamps', showButtons: 'youtubeShowButtons',
  } };

  assert.equal(applicationIdForPresence(), DISCORD_CLIENT_ID);
  assert.deepEqual(presenceDetailsForTrack(track, settings), {
    statusDisplay: 'app',
    showArtwork: false,
    showTimestamps: true,
    showButtons: true,
  });
});

test('normalizes and selects each service status display preference', () => {
  const settings = normalizeSettings({
    youtubeStatusDisplay: 'creator',
    movies67StatusDisplay: 'invalid',
    twitchStatusDisplay: 'streamer',
    kickStatusDisplay: 'stream',
  });
  const keys = {
    youtube: { statusDisplay: 'youtubeStatusDisplay' },
    movies67: { statusDisplay: 'movies67StatusDisplay' },
    twitch: { statusDisplay: 'twitchStatusDisplay' },
    kick: { statusDisplay: 'kickStatusDisplay' },
  };

  assert.equal(presenceDetailsForTrack({ settingKeys: keys.youtube }, settings).statusDisplay, 'creator');
  assert.equal(presenceDetailsForTrack({ settingKeys: keys.movies67 }, settings).statusDisplay, 'app');
  assert.equal(presenceDetailsForTrack({ settingKeys: keys.twitch }, settings).statusDisplay, 'streamer');
  assert.equal(presenceDetailsForTrack({ settingKeys: keys.kick }, settings).statusDisplay, 'stream');
});

test('applies installed Activity preferences to paused filtering and presence details', () => {
  const track = { activityId: 'sample-activity', source: 'sample-activity', playing: false };
  assert.equal(isTrackAllowed(track, DEFAULT_SETTINGS, { showPaused: false }), false);
  assert.equal(isTrackAllowed(track, DEFAULT_SETTINGS, { showPaused: true }), true);
  assert.deepEqual(presenceDetailsForTrack(track, DEFAULT_SETTINGS, {
    statusDisplay: 'track',
    showArtwork: false,
    showTimestamps: false,
    showButtons: false,
  }), {
    statusDisplay: 'track',
    showArtwork: false,
    showTimestamps: false,
    showButtons: false,
  });
});
