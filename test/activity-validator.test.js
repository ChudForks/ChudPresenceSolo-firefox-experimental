import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_API_VERSION,
  normalizeActivityReport,
  validateActivityMetadata,
  validateActivitySource,
} from '../extension/core/activity-validator.js';

function metadata(overrides = {}) {
  return {
    id: 'sample-activity',
    name: 'Sample Activity',
    description: 'A sample website observer.',
    version: '1.2.3',
    apiVersion: ACTIVITY_API_VERSION,
    matches: ['https://example.com/*'],
    entry: 'activity.js',
    ...overrides,
  };
}

test('validates metadata and fixes execution to the isolated user-script world', () => {
  const normalized = validateActivityMetadata(metadata());
  assert.equal(normalized.executionWorld, 'USER_SCRIPT');
  assert.equal(normalized.frames, 'top');
  assert.deepEqual(normalized.network, []);
  assert.deepEqual(normalized.matches, ['https://example.com/*']);
  assert.equal(validateActivityMetadata(metadata({ frames: 'all' })).frames, 'all');
  assert.deepEqual(validateActivityMetadata(metadata({ network: ['https://api.example.com/*'] })).network, ['https://api.example.com/*']);
});

test('rejects unsupported metadata, broad hosts, and insecure website patterns', () => {
  assert.throws(() => validateActivityMetadata(metadata({ permissions: ['tabs'] })), /unsupported field/);
  assert.throws(() => validateActivityMetadata(metadata({ matches: ['https://*/*'] })), /invalid or duplicate/);
  assert.throws(() => validateActivityMetadata(metadata({ matches: ['http://example.com/*'] })), /invalid or duplicate/);
  assert.throws(() => validateActivityMetadata(metadata({ executionWorld: 'MAIN' })), /isolated USER_SCRIPT/);
  assert.throws(() => validateActivityMetadata(metadata({ frames: 'parent-and-child' })), /frames must be top or all/);
  assert.throws(() => validateActivityMetadata(metadata({ network: ['http://api.example.com/*'] })), /network must contain/);
  assert.throws(() => validateActivityMetadata(metadata({ network: ['https://discord.com/api/*'] })), /cannot declare Discord/);
});

test('validates discovery metadata and excluded URL patterns', () => {
  const expanded = metadata({
    aliases: ['YT Music', 'YTM'],
    tags: ['music', 'streaming'],
    defaultMediaKind: 'song',
    excludeMatches: ['https://example.com/embed/*'],
    contributors: [{ name: 'Activity author', url: 'https://example.com/profile' }],
    serviceUrl: 'https://example.com/',
  });
  assert.deepEqual(validateActivityMetadata(expanded).aliases, ['YT Music', 'YTM']);
  assert.deepEqual(validateActivityMetadata(expanded).tags, ['music', 'streaming']);
  assert.equal(validateActivityMetadata(expanded).defaultMediaKind, 'song');
  assert.deepEqual(validateActivityMetadata(expanded).excludeMatches, ['https://example.com/embed/*']);
  assert.throws(() => validateActivityMetadata(metadata({ aliases: ['same', 'same'] })), /aliases/);
  assert.throws(() => validateActivityMetadata(metadata({ tags: ['Invalid Tag'] })), /tags/);
  assert.throws(() => validateActivityMetadata(metadata({ defaultMediaKind: 'music' })), /defaultMediaKind/);
  assert.throws(() => validateActivityMetadata(metadata({ excludeMatches: ['http://example.com/private/*'] })), /excludeMatches/);
  assert.throws(() => validateActivityMetadata(metadata({ serviceUrl: 'javascript:alert(1)' })), /HTTPS URL/);
});

test('validates declarative Activity settings for boolean, select, string, and numeric controls', () => {
  const settings = [
    { id: 'showAlbum', type: 'boolean', label: 'Show album', default: true },
    { id: 'displayMode', type: 'select', label: 'Display mode', default: 'artist', options: [
      { label: 'Artist', value: 'artist' }, { label: 'Album', value: 'album' },
    ] },
    { id: 'prefix', type: 'string', label: 'Prefix', default: '', maxLength: 20 },
    { id: 'volume', type: 'range', label: 'Volume', default: 50, min: 0, max: 100, step: 5 },
    { id: 'offset', type: 'number', label: 'Offset', default: 0, min: -10, max: 10 },
  ];
  assert.deepEqual(validateActivityMetadata(metadata({ settings })).settings, settings);
  assert.throws(() => validateActivityMetadata(metadata({ settings: [settings[0], settings[0]] })), /unique lowercase identifiers/);
  assert.throws(() => validateActivityMetadata(metadata({ settings: [{ ...settings[1], default: 'unknown' }] })), /default must match/);
  assert.throws(() => validateActivityMetadata(metadata({ settings: [{ ...settings[3], default: 42 }] })), /outside its allowed values/);
  assert.throws(() => validateActivityMetadata(metadata({ settings: [{ ...settings[0], enabled: true }] })), /unsupported field/);
});

test('enforces Activity source size and non-empty content', () => {
  assert.equal(validateActivitySource('globalThis.started = true;'), 'globalThis.started = true;');
  assert.throws(() => validateActivitySource('  '), /non-empty JavaScript/);
  assert.throws(() => validateActivitySource(`//${'x'.repeat(512 * 1024)}`), /512 KB size limit/);
});

test('normalizes a bounded HTTPS Activity report', () => {
  assert.deepEqual(normalizeActivityReport({
    kind: 'song',
    media: { title: '  Song title  ', artist: ' Artist ' },
    playback: { state: 'playing', position: 12.5, duration: 180 },
    artwork: { large: 'https://cdn.example.com/cover.png' },
    buttons: [{ label: 'Open', url: 'https://music.example.com/watch?id=1' }],
  }), {
    kind: 'song',
    media: { title: 'Song title', artist: 'Artist' },
    playback: { state: 'playing', position: 12.5, duration: 180, live: false, rate: 1 },
    display: { details: 'Song title', state: 'Artist', statusDisplay: 'details' },
    artwork: { large: 'https://cdn.example.com/cover.png' },
    buttons: [{ label: 'Open', url: 'https://music.example.com/watch?id=1' }],
    visibility: 'normal',
  });
});

test('supplies kind-specific display defaults and normalized playback defaults', () => {
  assert.deepEqual(normalizeActivityReport({
    kind: 'episode',
    media: { title: 'The episode', series: 'The series', season: 2, episode: 4 },
  }), {
    kind: 'episode',
    media: { title: 'The episode', series: 'The series', season: 2, episode: 4 },
    playback: { state: 'playing', position: 0, duration: 0, live: false, rate: 1 },
    display: { details: 'The series', state: 'The episode', statusDisplay: 'details' },
    artwork: {},
    buttons: [],
    visibility: 'normal',
  });
});

test('rejects unsafe URLs, invalid kinds, visibility values, and undeclared report fields', () => {
  assert.throws(() => normalizeActivityReport({
    kind: 'video', media: { title: 'Title' }, artwork: { large: 'http://example.com' },
  }), /HTTPS URL/);
  assert.throws(() => normalizeActivityReport({ kind: 'music', media: { title: 'Title' } }), /supported generic Activity kinds/);
  assert.throws(() => normalizeActivityReport({ kind: 'video', media: { title: 'Title' }, source: 'other' }), /unsupported field/);
  assert.throws(() => normalizeActivityReport({
    kind: 'movie', media: { title: 'Title' }, visibility: 'hidden',
  }), /visibility must be/);
});

test('enforces nested field limits, playback values, and the two-button maximum', () => {
  assert.throws(() => normalizeActivityReport({ kind: 'movie', media: { title: 'x'.repeat(257) } }), /media.title/);
  assert.throws(() => normalizeActivityReport({
    kind: 'movie', media: { title: 'Title' }, playback: { rate: 17 },
  }), /playback.rate/);
  assert.throws(() => normalizeActivityReport({
    kind: 'movie', media: { title: 'Title' }, buttons: [
      { label: '1', url: 'https://example.com/1' },
      { label: '2', url: 'https://example.com/2' },
      { label: '3', url: 'https://example.com/3' },
    ],
  }), /at most two/);
});
