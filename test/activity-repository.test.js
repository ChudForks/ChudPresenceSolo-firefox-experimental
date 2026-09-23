import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadActivity, validateCatalog } from '../extension/core/activity-repository.js';

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
  const source = 'ChudPresence.report({ kind: "song", media: { title: "Song" } });';
  const icon = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const files = new Map([
    ['metadata.json', metadata],
    ['activity.js', source],
    ['icon.png', icon],
  ]);
  return { metadata, source, icon, files };
}

async function entryFor(fixture, overrides = {}) {
  const metadata = JSON.parse(fixture.metadata);
  const metadataFields = ['author', 'contributors', 'category', 'aliases', 'tags', 'matches', 'excludeMatches',
    'serviceUrl', 'homepage', 'repository', 'presence', 'defaultMediaKind', 'frames', 'network', 'settings'];
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    version: metadata.version,
    apiVersion: metadata.apiVersion,
    ...Object.fromEntries(metadataFields.filter((field) => metadata[field] !== undefined).map((field) => [field, metadata[field]])),
    entry: 'activities/youtube-music/activity.js',
    metadata: 'activities/youtube-music/metadata.json',
    sha256: await sha256(fixture.source),
    metadataSha256: await sha256(fixture.metadata),
    icon: 'activities/youtube-music/icon.png',
    iconSha256: await sha256(fixture.icon),
    ...overrides,
  };
}

test('validates expanded catalog metadata and carries it into the verified package', async () => {
  const fixture = createFixture();
  const metadata = JSON.parse(fixture.metadata);
  metadata.aliases = ['YT Music', 'YTM'];
  metadata.tags = ['music', 'streaming'];
  metadata.defaultMediaKind = 'song';
  metadata.excludeMatches = ['https://music.youtube.com/shorts/*'];
  metadata.contributors = [{ name: 'Sample Author', url: 'https://example.com/author' }];
  metadata.serviceUrl = 'https://music.youtube.com/';
  fixture.metadata = JSON.stringify(metadata);
  fixture.files.set('metadata.json', fixture.metadata);
  stubRepositoryFetch(fixture);
  try {
    const entry = await entryFor(fixture);
    const catalog = validateCatalog({ schemaVersion: 1, revision: 'c'.repeat(40), activities: [entry] });
    assert.deepEqual(catalog.activities[0].aliases, metadata.aliases);
    const activityPackage = await downloadActivity('youtube-music', catalog);
    assert.deepEqual(activityPackage.metadata.tags, metadata.tags);
    assert.deepEqual(activityPackage.metadata.excludeMatches, metadata.excludeMatches);
    assert.equal(activityPackage.metadata.defaultMediaKind, 'song');
    assert.equal(activityPackage.metadata.serviceUrl, metadata.serviceUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
      revision: 'a'.repeat(40),
      activities: [await entryFor(fixture)],
    });
    assert.equal(activityPackage.metadata.icon, 'icon.png');
    assert.equal(activityPackage.icon, `data:image/png;base64,${Buffer.from(fixture.icon).toString('base64')}`);
    assert.equal(activityPackage.source, fixture.source);
    assert.deepEqual(activityPackage.provenance, {
      repository: 'ChudForks/ChudPresence-Activities',
      revision: 'a'.repeat(40),
      codeSha256: await sha256(fixture.source),
      metadataSha256: await sha256(fixture.metadata),
      iconSha256: await sha256(fixture.icon),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a service icon that fails its catalog integrity hash', async () => {
  const fixture = createFixture();
  stubRepositoryFetch(fixture);
  try {
    await assert.rejects(downloadActivity('youtube-music', {
      revision: 'a'.repeat(40),
      activities: [await entryFor(fixture, { iconSha256: '0'.repeat(64) })],
    }), /Activity icon integrity check failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps future Activity API versions readable in mixed catalogs', async () => {
  const fixture = createFixture();
  const currentEntry = await entryFor(fixture);
  const futureEntry = await entryFor(fixture, {
    id: 'future-activity',
    apiVersion: 2,
    minExtensionVersion: '1.12.0',
    metadata: 'activities/future-activity/metadata.json',
    entry: 'activities/future-activity/activity.js',
    icon: 'activities/future-activity/icon.png',
  });
  const catalog = validateCatalog({ schemaVersion: 1, revision: 'b'.repeat(40), activities: [currentEntry, futureEntry] });
  assert.equal(catalog.activities.length, 2);
  assert.equal(catalog.activities[1].apiVersion, 2);
  assert.equal(catalog.activities[1].minExtensionVersion, '1.12.0');
});

test('rejects unsafe catalog network permissions before an install prompt', async () => {
  const fixture = createFixture();
  const base = await entryFor(fixture);
  for (const network of [
    ['https://discord.com/api/*'],
    ['https://api.example.com/*', 'https://api.example.com/*'],
    ['http://api.example.com/*'],
  ]) {
    assert.throws(() => validateCatalog({ schemaVersion: 1, activities: [{ ...base, network }] }),
      /invalid network permissions/);
  }
});

test('rejects catalog display or permission fields that disagree with verified metadata', async () => {
  const fixture = createFixture();
  stubRepositoryFetch(fixture);
  try {
    const base = await entryFor(fixture);
    for (const override of [
      { name: 'Misleading Activity' },
      { network: ['https://api.example.com/*'] },
      { settings: [{ id: 'enabled', type: 'boolean', label: 'Enabled', default: true }] },
    ]) {
      await assert.rejects(downloadActivity('youtube-music', {
        revision: 'a'.repeat(40),
        activities: [{ ...base, ...override }],
      }), /Activity metadata does not match its catalog entry/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refuses to install a catalog package requiring an unsupported API version', async () => {
  const fixture = createFixture();
  const metadata = JSON.parse(fixture.metadata);
  metadata.apiVersion = 2;
  fixture.metadata = JSON.stringify(metadata);
  fixture.files.set('metadata.json', fixture.metadata);
  stubRepositoryFetch(fixture);
  try {
    await assert.rejects(downloadActivity('youtube-music', {
      revision: 'a'.repeat(40),
      activities: [await entryFor(fixture, { apiVersion: 2 })],
    }), /Activity API version 2 is not supported/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
