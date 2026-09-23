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

test('keeps reports per frame and restores another frame when the current frame clears', () => {
  const registry = new ActivityRegistry();
  const parent = { source: 'activity', activityId: 'sample', title: 'Parent page' };
  const player = { source: 'activity', activityId: 'sample', title: 'Embedded player' };

  registry.update(7, 'top-document', parent, 0);
  registry.update(7, 'player-document', player, 3);
  assert.deepEqual(registry.tracks().get(7), player);
  assert.equal(registry.clearActivity('sample', 7, 'player-document', 3), true);
  assert.deepEqual(registry.tracks().get(7), parent);
});

test('a late iframe clear cannot remove a replacement document in that frame', () => {
  const registry = new ActivityRegistry();
  const oldPlayer = { source: 'activity', activityId: 'sample', title: 'Old player' };
  const newPlayer = { source: 'activity', activityId: 'sample', title: 'New player' };

  registry.update(7, 'old-player-document', oldPlayer, 3);
  registry.update(7, 'new-player-document', newPlayer, 3);
  assert.equal(registry.clearActivity('sample', 7, 'old-player-document', 3), false);
  assert.deepEqual(registry.tracks().get(7), newPlayer);
});
