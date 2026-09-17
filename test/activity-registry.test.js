import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityRegistry } from '../extension/core/activity-registry.js';

test('accepts a new document immediately after same-tab navigation', () => {
  const registry = new ActivityRegistry();

  registry.update(7, 'twitch-document', { source: 'twitch', title: 'Stream' });
  assert.equal(registry.clearDocument(7, 'twitch-document'), true);

  registry.update(7, 'youtube-document', { source: 'youtube', title: 'Video' });
  assert.deepEqual(registry.tracks().get(7), { source: 'youtube', title: 'Video' });
});

test('late unload from the previous document cannot clear the new activity', () => {
  const registry = new ActivityRegistry();

  registry.update(7, 'twitch-document', { source: 'twitch', title: 'Stream' });
  registry.update(7, 'youtube-document', { source: 'youtube', title: 'Video' });

  assert.equal(registry.clearDocument(7, 'twitch-document'), false);
  assert.deepEqual(registry.tracks().get(7), { source: 'youtube', title: 'Video' });
});
