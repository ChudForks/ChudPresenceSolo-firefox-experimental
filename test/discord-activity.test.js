import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHeadlessActivity } from '../extension/discord/activity-builder.js';

test('maps a presence intent to the headless session activity shape', () => {
  const activity = buildHeadlessActivity({
    name: 'YouTube',
    type: 'watching',
    details: 'A Video',
    state: 'A Channel',
    statusDisplayType: 'state',
    timestamps: { start: 970, end: 1180 },
    assets: { largeImage: 'https://example.com/art.jpg', largeText: 'YouTube' },
    buttons: [{ label: 'Watch', url: 'https://youtube.com/watch?v=abcdefghijk' }],
  }, '123456789012345678');

  assert.deepEqual(activity, {
    application_id: '123456789012345678',
    platform: 'desktop',
    supported_platforms: ['desktop'],
    name: 'YouTube',
    type: 3,
    details: 'A Video',
    state: 'A Channel',
    status_display_type: 1,
    timestamps: { start: 970000, end: 1180000 },
    assets: { large_image: 'https://example.com/art.jpg', large_text: 'YouTube' },
    buttons: [{ label: 'Watch', url: 'https://youtube.com/watch?v=abcdefghijk' }],
    metadata: { button_urls: ['https://youtube.com/watch?v=abcdefghijk'] },
  });
});

test('rejects invalid application IDs and maps listening activities', () => {
  assert.equal(buildHeadlessActivity({ details: 'Track' }, ''), null);
  assert.equal(buildHeadlessActivity({ details: 'Track' }, 'not-a-snowflake'), null);
  assert.equal(buildHeadlessActivity({ details: 'Track', type: 'listening' }, '123456789012345678').type, 2);
});
