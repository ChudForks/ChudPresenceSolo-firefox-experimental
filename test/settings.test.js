import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationIdForSource,
  DEFAULT_SETTINGS,
  isTrackAllowed,
  normalizeSettings,
  presenceDetailsForSource,
} from '../extension/core/settings.js';
import { SERVICE_APPLICATION_IDS } from '../extension/config.js';

test('normalizes missing and invalid settings to defaults', () => {
  assert.deepEqual(normalizeSettings({ enabled: false, showArtwork: 'no' }), {
    ...DEFAULT_SETTINGS,
    enabled: false,
  });
});

test('filters disabled sources', () => {
  assert.equal(isTrackAllowed({ source: 'youtube', playing: true }, {
    ...DEFAULT_SETTINGS,
    sourceYouTube: false,
  }), false);
  assert.equal(isTrackAllowed({ source: 'crunchyroll', playing: true }, DEFAULT_SETTINGS), true);
});

test('filters paused tracks only when configured', () => {
  const paused = { source: 'youtubeMusic', playing: false };
  assert.equal(isTrackAllowed(paused, DEFAULT_SETTINGS), true);
  assert.equal(isTrackAllowed(paused, { ...DEFAULT_SETTINGS, youtubeMusicShowPaused: false }), false);
  assert.equal(isTrackAllowed(
    { source: 'youtube', playing: false },
    { ...DEFAULT_SETTINGS, youtubeMusicShowPaused: false },
  ), true);
});

test('migrates legacy global presence preferences to every service', () => {
  const normalized = normalizeSettings({
    showPaused: false,
    showArtwork: false,
    showTimestamps: true,
    showButtons: false,
  });

  for (const prefix of ['youtube', 'youtubeMusic', 'crunchyroll', 'movies67', 'twitch', 'kick']) {
    assert.equal(normalized[`${prefix}ShowPaused`], false);
    assert.equal(normalized[`${prefix}ShowArtwork`], false);
    assert.equal(normalized[`${prefix}ShowTimestamps`], true);
    assert.equal(normalized[`${prefix}ShowButtons`], false);
  }
});

test('uses presence details and hard-coded application IDs for the active service', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    youtubeShowArtwork: false,
    crunchyrollShowButtons: false,
  };

  assert.equal(applicationIdForSource('youtube', settings), SERVICE_APPLICATION_IDS.youtube);
  assert.equal(applicationIdForSource('crunchyroll', settings), SERVICE_APPLICATION_IDS.crunchyroll);
  assert.equal(applicationIdForSource('twitch', settings), SERVICE_APPLICATION_IDS.twitch);
  assert.equal(applicationIdForSource('kick', settings), SERVICE_APPLICATION_IDS.kick);
  assert.deepEqual(presenceDetailsForSource('youtube', settings), {
    statusDisplay: 'app',
    showArtwork: false,
    showTimestamps: true,
    showButtons: true,
  });
  assert.deepEqual(presenceDetailsForSource('crunchyroll', settings), {
    statusDisplay: 'app',
    showArtwork: true,
    showTimestamps: true,
    showButtons: false,
  });
});

test('normalizes and selects each service status display preference', () => {
  const settings = normalizeSettings({
    youtubeStatusDisplay: 'creator',
    youtubeMusicStatusDisplay: 'track',
    crunchyrollStatusDisplay: 'episode',
    movies67StatusDisplay: 'invalid',
    twitchStatusDisplay: 'streamer',
    kickStatusDisplay: 'stream',
  });

  assert.equal(presenceDetailsForSource('youtube', settings).statusDisplay, 'creator');
  assert.equal(presenceDetailsForSource('youtubeMusic', settings).statusDisplay, 'track');
  assert.equal(presenceDetailsForSource('crunchyroll', settings).statusDisplay, 'episode');
  assert.equal(presenceDetailsForSource('movies67', settings).statusDisplay, 'app');
  assert.equal(presenceDetailsForSource('twitch', settings).statusDisplay, 'streamer');
  assert.equal(presenceDetailsForSource('kick', settings).statusDisplay, 'stream');
});
