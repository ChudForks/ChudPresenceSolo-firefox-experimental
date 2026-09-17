import assert from 'node:assert/strict';
import test from 'node:test';
import { isReportable, selectActivity } from '../extension/core/activity.js';

test('rejects idle, ad, and untitled reports', () => {
  assert.equal(isReportable({ title: 'Song' }), true);
  assert.equal(isReportable({ idle: true, title: 'Song' }), false);
  assert.equal(isReportable({ ad: true, title: 'Ad' }), false);
  assert.equal(isReportable({ playing: true }), false);
});

test('prefers a playing activity to a paused activity', () => {
  const tracks = new Map([
    [1, { title: 'Paused', playing: false }],
    [2, { title: 'Playing', playing: true }],
  ]);
  assert.deepEqual(selectActivity(tracks, 1), { tabId: 2, track: tracks.get(2) });
});

test('keeps the active tab when it remains eligible', () => {
  const tracks = new Map([
    [1, { title: 'First', playing: true }],
    [2, { title: 'Second', playing: true }],
  ]);
  assert.deepEqual(selectActivity(tracks, 1), { tabId: 1, track: tracks.get(1) });
});

test('returns an empty selection when nothing is reportable', () => {
  assert.deepEqual(selectActivity(new Map([[1, { idle: true }]]), 1), {
    tabId: null,
    track: null,
  });
});
