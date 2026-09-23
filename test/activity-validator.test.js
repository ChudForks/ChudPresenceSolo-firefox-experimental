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
  assert.deepEqual(normalized.matches, ['https://example.com/*']);
});

test('rejects unsupported metadata, broad hosts, and insecure website patterns', () => {
  assert.throws(() => validateActivityMetadata(metadata({ permissions: ['tabs'] })), /unsupported field/);
  assert.throws(() => validateActivityMetadata(metadata({ matches: ['https://*/*'] })), /invalid or duplicate/);
  assert.throws(() => validateActivityMetadata(metadata({ matches: ['http://example.com/*'] })), /invalid or duplicate/);
  assert.throws(() => validateActivityMetadata(metadata({ executionWorld: 'MAIN' })), /isolated USER_SCRIPT/);
});

test('enforces Activity source size and non-empty content', () => {
  assert.equal(validateActivitySource('globalThis.started = true;'), 'globalThis.started = true;');
  assert.throws(() => validateActivitySource('  '), /non-empty JavaScript/);
  assert.throws(() => validateActivitySource(`//${'x'.repeat(512 * 1024)}`), /512 KB size limit/);
});

test('normalizes a bounded HTTPS Activity report', () => {
  assert.deepEqual(normalizeActivityReport({
    title: '  Song title  ',
    artist: ' Artist ',
    artwork: 'https://cdn.example.com/cover.png',
    url: 'https://music.example.com/watch?id=1',
    playing: true,
    position: 12.5,
    duration: 180,
    kind: 'song',
    buttons: [{ label: 'Open', url: 'https://music.example.com/watch?id=1' }],
  }), {
    title: 'Song title',
    artist: 'Artist',
    artwork: 'https://cdn.example.com/cover.png',
    url: 'https://music.example.com/watch?id=1',
    playing: true,
    position: 12.5,
    duration: 180,
    kind: 'song',
    buttons: [{ label: 'Open', url: 'https://music.example.com/watch?id=1' }],
  });
});

test('rejects unsafe URLs, invalid kinds, and undeclared report fields', () => {
  assert.throws(() => normalizeActivityReport({ title: 'Title', url: 'http://example.com' }), /HTTPS URL/);
  assert.throws(() => normalizeActivityReport({ title: 'Title', kind: 'music' }), /supported generic Activity kinds/);
  assert.throws(() => normalizeActivityReport({ title: 'Title', source: 'other' }), /unsupported field/);
});
