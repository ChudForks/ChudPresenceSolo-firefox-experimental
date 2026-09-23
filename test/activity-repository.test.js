import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadActivity } from '../extension/core/activity-repository.js';

const originalFetch = globalThis.fetch;

async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createFixture() {
  const metadata = JSON.stringify({
    id: 'youtube-music',
    name: 'YouTube Music',
    description: 'Show current music playback.',
    version: '1.0.0',
    apiVersion: 1,
    matches: ['https://music.youtube.com/*'],
    entry: 'activity.js',
    icon: 'icon.png',
  });
  const source = 'ChudPresence.report({ title: "Song", kind: "song" });';
  const icon = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const files = new Map([
    ['metadata.json', metadata],
    ['activity.js', source],
    ['icon.png', icon],
  ]);
  return { metadata, source, icon, files };
}

async function entryFor(fixture, overrides = {}) {
  return {
    id: 'youtube-music',
    name: 'YouTube Music',
    description: 'Show current music playback.',
    version: '1.0.0',
    apiVersion: 1,
    matches: ['https://music.youtube.com/*'],
    entry: 'activities/youtube-music/activity.js',
    metadata: 'activities/youtube-music/metadata.json',
    sha256: await sha256(fixture.source),
    metadataSha256: await sha256(fixture.metadata),
    icon: 'activities/youtube-music/icon.png',
    iconSha256: await sha256(fixture.icon),
    ...overrides,
  };
}

function stubRepositoryFetch(fixture) {
  globalThis.fetch = async (url) => {
    const file = new URL(url).pathname.split('/').at(-1);
    const body = fixture.files.get(file);
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(body, { status: 200 });
  };
}

test('downloads and verifies an Activity service icon with its package', async () => {
  const fixture = createFixture();
  stubRepositoryFetch(fixture);
  try {
    const activityPackage = await downloadActivity('youtube-music', {
      activities: [await entryFor(fixture)],
    });
    assert.equal(activityPackage.metadata.icon, 'icon.png');
    assert.equal(activityPackage.icon, `data:image/png;base64,${Buffer.from(fixture.icon).toString('base64')}`);
    assert.equal(activityPackage.source, fixture.source);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a service icon that fails its catalog integrity hash', async () => {
  const fixture = createFixture();
  stubRepositoryFetch(fixture);
  try {
    await assert.rejects(downloadActivity('youtube-music', {
      activities: [await entryFor(fixture, { iconSha256: '0'.repeat(64) })],
    }), /Activity icon integrity check failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
