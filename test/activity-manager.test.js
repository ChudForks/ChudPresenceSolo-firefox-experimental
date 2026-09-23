import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityManager } from '../extension/core/activity-manager.js';

function createFakeApi() {
  const data = {};
  const permissions = new Set(['userScripts', 'https://example.com/*']);
  const scripts = new Map();
  let failNextWrite = false;
  const project = (keys) => {
    if (keys == null) return structuredClone(data);
    const wanted = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
  };
  const api = {
    storage: {
      local: {
        async get(keys) { return project(keys); },
        async set(values) {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('Simulated storage failure');
          }
          Object.assign(data, structuredClone(values));
        },
      },
    },
    permissions: {
      async contains({ permissions: requested = [], origins = [] }) {
        return [...requested, ...origins].every((permission) => permissions.has(permission));
      },
    },
    userScripts: {
      async getScripts() { return [...scripts.values()]; },
      async configureWorld() {},
      async register(definitions) { for (const definition of definitions) scripts.set(definition.id, definition); },
      async update(definitions) { for (const definition of definitions) scripts.set(definition.id, definition); },
      async unregister({ ids }) { for (const id of ids) scripts.delete(id); },
    },
  };
  return {
    api,
    scripts,
    data,
    failNextWrite() { failNextWrite = true; },
  };
}

function activityPackage() {
  return {
    metadata: {
      id: 'sample-activity',
      name: 'Sample Activity',
      description: 'A sample observer.',
      version: '1.0.0',
      apiVersion: 1,
      matches: ['https://example.com/*'],
      entry: 'activity.js',
    },
    source: 'ChudPresence.report({ title: "A page" });',
    sourceType: 'local',
  };
}

test('installs into an isolated per-Activity world and restores after registrations are cleared', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });

  await manager.install(activityPackage());
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), true);
  assert.equal(fake.scripts.get('chudpresence-activity-sample-activity').world, 'USER_SCRIPT');

  fake.scripts.clear();
  const restored = await manager.restoreAll();
  assert.equal(restored.restored, 1);
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), true);
});

test('accepts reports only from the installed Activity world and declared site', async () => {
  const fake = createFakeApi();
  const reports = [];
  const manager = new ActivityManager({ api: fake.api, onReport: (value) => reports.push(value) });
  await manager.install(activityPackage());
  const message = { type: 'CHUDPRESENCE_ACTIVITY_REPORT', report: { title: 'Episode', kind: 'episode' } };

  assert.equal(await manager.handleUserScriptMessage(message, {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 4 },
    documentId: 'doc-a',
    url: 'https://example.com/watch/1',
  }), true);
  assert.equal(reports[0].track.activityId, 'sample-activity');
  assert.equal(reports[0].track.source, 'sample-activity');
  assert.equal(await manager.handleUserScriptMessage(message, {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 4 },
    url: 'https://elsewhere.example/watch/1',
  }), false);
  assert.equal(reports.length, 1);
});

test('ignores a delayed clear from an older document in the same tab', async () => {
  const fake = createFakeApi();
  const cleared = [];
  const manager = new ActivityManager({ api: fake.api, onClear: (...args) => cleared.push(args) });
  await manager.install(activityPackage());
  const baseSender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 9 },
    url: 'https://example.com/new-page',
  };
  await manager.handleUserScriptMessage({
    type: 'CHUDPRESENCE_ACTIVITY_REPORT',
    report: { title: 'Current page' },
  }, { ...baseSender, documentId: 'new-document' });

  assert.equal(await manager.handleUserScriptMessage({
    type: 'CHUDPRESENCE_ACTIVITY_CLEAR',
  }, { ...baseSender, url: 'https://example.com/old-page', documentId: 'old-document' }), true);
  assert.equal((await manager.listInstalled())[0].status, 'detected');
  assert.deepEqual(cleared, []);

  await manager.handleUserScriptMessage({ type: 'CHUDPRESENCE_ACTIVITY_CLEAR' }, {
    ...baseSender,
    documentId: 'new-document',
  });
  assert.equal((await manager.listInstalled())[0].status, 'waiting');
  assert.equal(cleared.length, 1);
});

test('disable and remove unregister the script and update installed state', async () => {
  const fake = createFakeApi();
  const cleared = [];
  const manager = new ActivityManager({ api: fake.api, onClear: (id) => cleared.push(id) });
  await manager.install(activityPackage());

  await manager.setEnabled('sample-activity', false);
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), false);
  assert.equal((await manager.listInstalled())[0].status, 'disabled');

  assert.equal(await manager.remove('sample-activity'), true);
  assert.equal((await manager.listInstalled()).length, 0);
  assert.deepEqual(cleared, ['sample-activity', 'sample-activity']);
});

test('persists and lists per-Activity presence preferences', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());

  assert.deepEqual(manager.preferencesFor('sample-activity'), {
    showPaused: true,
    statusDisplay: 'app',
    showArtwork: true,
    showTimestamps: true,
    showButtons: true,
  });
  const saved = await manager.setPreferences('sample-activity', {
    showPaused: false,
    statusDisplay: 'track',
    showArtwork: false,
  });
  assert.deepEqual(saved.preferences, {
    showPaused: false,
    statusDisplay: 'track',
    showArtwork: false,
    showTimestamps: true,
    showButtons: true,
  });
  assert.deepEqual((await manager.listInstalled())[0].preferences, saved.preferences);
  assert.deepEqual(manager.preferencesFor('sample-activity'), saved.preferences);
});

test('stores and exposes an optional package-local service icon', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const activity = activityPackage();
  activity.metadata.icon = 'icon.png';
  activity.icon = icon;

  await manager.install(activity);
  assert.equal((await manager.get('sample-activity')).icon, 'iVBORw0KGgo=');
  assert.equal((await manager.listInstalled())[0].icon, icon);
  await assert.rejects(manager.install({ ...activity, icon: 'data:image/svg+xml;base64,PHN2Zz4=' }), /base64 PNG/);
  await assert.rejects(manager.install({ ...activity, icon: undefined }), /supplied together/);
});

test('rejects unsupported per-Activity preferences without changing saved values', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  const original = manager.preferencesFor('sample-activity');

  await assert.rejects(manager.setPreferences('sample-activity', { showArtwork: 'no' }), /showArtwork must be a boolean/);
  await assert.rejects(manager.setPreferences('sample-activity', { applicationId: 'custom' }), /Unsupported Activity preference/);
  assert.deepEqual(manager.preferencesFor('sample-activity'), original);
});

test('rolls back script registration and in-memory records if storage fails', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  fake.failNextWrite();

  await assert.rejects(manager.install(activityPackage()), /Simulated storage failure/);
  assert.equal(fake.scripts.size, 0);
  assert.deepEqual(await manager.listInstalled(), []);
});

test('restores the prior enabled script if saving a disable fails', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  fake.failNextWrite();

  await assert.rejects(manager.setEnabled('sample-activity', false), /Simulated storage failure/);
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), true);
  assert.equal((await manager.listInstalled())[0].enabled, true);
});
