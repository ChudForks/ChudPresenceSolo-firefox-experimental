import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { ActivityManager } from '../extension/core/activity-manager.js';
import { shouldInvalidateActivityTab } from '../extension/core/tab-lifecycle.js';

function createFakeApi() {
  const data = {};
  const permissions = new Set(['userScripts', 'https://example.com/*']);
  const scripts = new Map();
  const sentMessages = [];
  const pageExecutions = [];
  const pageContext = { window: { someApplicationState: { title: 'Page-owned title', count: 3 } } };
  let nextPageExecutionResults = null;
  let fetchImplementation = async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  let failNextWrite = false;
  let failNextScriptUpdate = false;
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
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
      },
    },
    permissions: {
      async contains({ permissions: requested = [], origins = [] }) {
        return [...requested, ...origins].every((permission) => permissions.has(permission));
      },
      async getAll() { return { origins: [...permissions].filter((permission) => /^https?:\/\//.test(permission)) }; },
      async remove({ permissions: removedPermissions = [], origins = [] }) {
        for (const permission of [...removedPermissions, ...origins]) permissions.delete(permission);
        return true;
      },
    },
    userScripts: {
      async getScripts() { return [...scripts.values()]; },
      async configureWorld() {},
      async execute(injection) {
        pageExecutions.push(injection);
        if (injection.world === 'USER_SCRIPT') {
          return [{ documentId: injection.target.documentIds?.[0], frameId: 0, result: 'null' }];
        }
        if (nextPageExecutionResults) {
          const result = nextPageExecutionResults;
          nextPageExecutionResults = null;
          return result;
        }
        try {
          return [{
            documentId: injection.target.documentIds?.[0],
            frameId: 0,
            result: vm.runInNewContext(injection.js[0].code, pageContext),
          }];
        } catch (error) {
          return [{ documentId: injection.target.documentIds?.[0], frameId: 0, error: String(error?.message || error) }];
        }
      },
      async register(definitions) { for (const definition of definitions) scripts.set(definition.id, definition); },
      async update(definitions) {
        if (failNextScriptUpdate) {
          failNextScriptUpdate = false;
          throw new Error('Simulated script update failure');
        }
        for (const definition of definitions) scripts.set(definition.id, definition);
      },
      async unregister({ ids }) { for (const id of ids) scripts.delete(id); },
    },
    runtime: { getManifest() { return { version: '1.9.0' }; } },
    tabs: { async sendMessage(tabId, message, options) { sentMessages.push({ tabId, message, options }); } },
  };
  return {
    api,
    scripts,
    data,
    sentMessages,
    pageExecutions,
    pageContext,
    permissions,
    fetchImpl(...args) { return fetchImplementation(...args); },
    setFetchImplementation(implementation) { fetchImplementation = implementation; },
    setNextPageExecutionResults(results) { nextPageExecutionResults = results; },
    failNextWrite() { failNextWrite = true; },
    failNextScriptUpdate() { failNextScriptUpdate = true; },
  };
}

function createActivityPort(fake, sender, version) {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  let disconnected = false;
  return {
    name: `chudpresence-activity-v1:${version}`,
    sender,
    onMessage: {
      addListener(listener) { messageListeners.add(listener); },
      removeListener(listener) { messageListeners.delete(listener); },
    },
    onDisconnect: {
      addListener(listener) { disconnectListeners.add(listener); },
    },
    postMessage(message) {
      if (disconnected) throw new Error('Port is disconnected');
      fake.sentMessages.push({
        tabId: sender.tab.id,
        message: structuredClone(message),
        options: { documentId: sender.documentId },
      });
      for (const listener of messageListeners) listener(message);
      if (message.type === 'CHUDPRESENCE_ACTIVITY_ABORT') this.disconnect();
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
}

async function connectActivity(fake, manager, sender, version = '1.0.0') {
  const port = createActivityPort(fake, sender, version);
  assert.equal(await manager.handleUserScriptConnect(port), true);
  return port;
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
    source: 'ChudPresence.report({ kind: "video", media: { title: "A page" } });',
    sourceType: 'local',
  };
}

function activityReport(title = 'A page') {
  return { kind: 'video', media: { title } };
}

function activityRequest(operation, payload = {}, requestId = 'test-request') {
  return {
    type: 'CHUDPRESENCE_ACTIVITY_REQUEST',
    apiVersion: 1,
    requestId,
    operation,
    payload,
  };
}

test('installs into an isolated per-Activity world and restores after registrations are cleared', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });

  await manager.install(activityPackage());
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), true);
  assert.equal(fake.scripts.get('chudpresence-activity-sample-activity').world, 'USER_SCRIPT');
  assert.equal(fake.scripts.get('chudpresence-activity-sample-activity').allFrames, false);
  assert.match(fake.scripts.get('chudpresence-activity-sample-activity').js[0].code, /CHUDPRESENCE_ACTIVITY_REQUEST/);

  fake.scripts.clear();
  const restored = await manager.restoreAll();
  assert.equal(restored.restored, 1);
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), true);
});

test('provides a frozen ChudPresence runtime with report, page, and network helpers', async (t) => {
  const fake = createFakeApi();
  fake.permissions.add('https://api.example.com/*');
  const manager = new ActivityManager({ api: fake.api, fetchImpl: fake.fetchImpl });
  const activity = activityPackage();
  activity.metadata.network = ['https://api.example.com/*'];
  activity.metadata.settings = [
    { id: 'showAlbum', type: 'boolean', label: 'Show album', default: true },
    { id: 'displayMode', type: 'select', label: 'Display mode', default: 'artist', options: [
      { label: 'Artist', value: 'artist' }, { label: 'Album', value: 'album' },
    ] },
  ];
  activity.source = [
    'globalThis.__capturedPresence = ChudPresence;',
    'globalThis.__capturedPage = ChudPresence.page;',
    'globalThis.__settingChanges = [];',
    'ChudPresence.settings.onChange((change) => globalThis.__settingChanges.push(change));',
    'globalThis.__capturedSignal = ChudPresence.lifecycle.signal;',
    'globalThis.__upgradeEvents = [];',
    'ChudPresence.lifecycle.onUpgrade((change) => globalThis.__upgradeEvents.push(change));',
    'globalThis.__media = ChudPresence.media;',
    'globalThis.__mediaEvents = [];',
    'ChudPresence.media.onChange((event) => globalThis.__mediaEvents.push(event), { immediate: true });',
    'globalThis.__navigationEvents = [];',
    'globalThis.__navigation = ChudPresence.navigation;',
    'ChudPresence.navigation.onChange((change) => globalThis.__navigationEvents.push(change));',
    'ChudPresence.navigation.onChange(() => { globalThis.__navigationCallbackCount = (globalThis.__navigationCallbackCount || 0) + 1; });',
    'globalThis.__cleanupCount = 0;',
    'ChudPresence.lifecycle.onCleanup(() => { globalThis.__cleanupCount += 1; });',
    'ChudPresence.lifecycle.interval(() => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }, 5);',
    'globalThis.__directBrowser = typeof browser;',
    'globalThis.__windowBrowser = typeof window.browser;',
  ].join('\n');
  await manager.install(activity);
  const script = fake.scripts.get('chudpresence-activity-sample-activity').js[0].code;
  const calls = [];
  const runtimeListeners = new Set();
  let runtimePort;
  const pageSender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 41 }, frameId: 0, documentId: 'page-exec-doc', url: 'https://example.com/watch/1',
  };
  const browser = { runtime: {
    sendMessage(message) {
      calls.push(message);
      if (message.operation === 'page.execute' || message.operation === 'net.fetch' ||
          message.operation.startsWith('settings.') || message.operation.startsWith('storage.') || message.operation === 'log.write') {
        return manager.handleUserScriptMessage(structuredClone(message), pageSender);
      }
      return Promise.resolve({ ok: true, requestId: message.requestId });
    },
    connect({ name }) {
      runtimePort = {
        name,
        onMessage: { addListener(listener) { runtimeListeners.add(listener); } },
        onDisconnect: { addListener() {} },
        disconnect() {},
      };
      return runtimePort;
    },
  } };
  const eventListeners = new Map();
  const documentListeners = new Map();
  const observers = new Set();
  const video = {
    tagName: 'VIDEO', paused: false, ended: false, currentTime: 12, duration: 120,
    playbackRate: 1.25, volume: 0.5, muted: false,
    getBoundingClientRect() { return { width: 640, height: 360 }; },
  };
  const audio = {
    tagName: 'AUDIO', paused: true, ended: false, currentTime: 0, duration: 210,
    playbackRate: 1, volume: 1, muted: false,
    getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
  const mediaElements = [video, audio];
  const domElements = [];
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === 'video, audio') return mediaElements;
      return domElements.filter((node) => node.matches(selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.add(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; observers.delete(this); }
  }
  const pageWindow = {};
  pageWindow.top = pageWindow;
  pageWindow.window = pageWindow;
  pageWindow.self = pageWindow;
  pageWindow.location = { href: 'https://example.com/start' };
  pageWindow.history = {
    pushState(_state, _title, url) { pageWindow.location.href = new URL(url, pageWindow.location.href).toString(); },
    replaceState(_state, _title, url) { pageWindow.location.href = new URL(url, pageWindow.location.href).toString(); },
  };
  pageWindow.addEventListener = (type, listener) => {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type).add(listener);
  };
  pageWindow.removeEventListener = (type, listener) => eventListeners.get(type)?.delete(listener);
  pageWindow.setTimeout = setTimeout;
  pageWindow.clearTimeout = clearTimeout;
  pageWindow.setInterval = setInterval;
  pageWindow.clearInterval = clearInterval;
  pageWindow.document = document;
  const scope = vm.createContext({
    window: pageWindow, location: pageWindow.location, history: pageWindow.history, browser,
    document, MutationObserver: FakeMutationObserver,
    Date, Math, Object, Proxy, Reflect, WeakMap, AbortController,
  });
  vm.runInContext(script, scope);
  assert.equal(runtimePort.name, 'chudpresence-activity-v1:1.0.0');
  t.after(() => {
    for (const listener of eventListeners.get('pagehide') || []) listener({ type: 'pagehide' });
  });

  const api = pageWindow.__capturedPresence;
  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(api.runtime), true);
  assert.equal(api.runtime.activityId, 'sample-activity');
  assert.equal(api.runtime.activityVersion, '1.0.0');
  assert.equal(api.runtime.apiVersion, 1);
  assert.equal(api.runtime.extensionVersion, '1.9.0');
  assert.equal(api.runtime.frame.isTop, true);
  assert.equal(api.runtime.has('report'), true);
  assert.equal(api.runtime.has('lifecycle'), true);
  assert.equal(api.runtime.has('navigation'), true);
  assert.equal(api.runtime.has('media'), true);
  assert.equal(api.runtime.has('pageExecute'), true);
  assert.equal(api.runtime.has('netFetch'), true);
  assert.equal(api.runtime.has('storage'), true);
  assert.equal(api.runtime.has('settings'), true);
  assert.equal(api.runtime.has('dom'), true);
  assert.equal(api.runtime.has('log'), true);
  assert.equal(Object.isFrozen(api.page), true);
  assert.equal(Object.isFrozen(api.net), true);
  assert.equal(Object.isFrozen(api.settings), true);
  assert.equal(Object.isFrozen(api.dom), true);
  assert.equal(Object.isFrozen(api.log), true);
  assert.equal(typeof api.settings.get, 'function');
  assert.equal(typeof api.settings.getAll, 'function');
  assert.equal(typeof api.settings.onChange, 'function');
  assert.equal(api.runtime.has('storage'), true);
  assert.equal(Object.isFrozen(api.storage), true);
  assert.equal(typeof api.storage.get, 'function');
  assert.equal(typeof api.storage.set, 'function');
  assert.equal(typeof api.storage.remove, 'function');
  assert.equal(typeof api.storage.clear, 'function');
  assert.equal(pageWindow.__directBrowser, 'undefined');
  assert.equal(pageWindow.__windowBrowser, 'undefined');
  const pushState = pageWindow.history.pushState;
  const replaceState = pageWindow.history.replaceState;
  assert.equal(api.navigation.current, 'https://example.com/start');
  pageWindow.history.pushState({}, '', '/first');
  pageWindow.history.replaceState({}, '', '/final');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(api.navigation.current, 'https://example.com/final');
  assert.equal(pageWindow.__navigationEvents.length, 1);
  assert.equal(pageWindow.__navigationEvents[0].oldUrl, 'https://example.com/start');
  assert.equal(pageWindow.__navigationEvents[0].newUrl, 'https://example.com/final');
  assert.equal(pageWindow.__navigationEvents[0].type, 'history');
  assert.equal(pageWindow.__navigationCallbackCount, 1);
  assert.equal(pageWindow.history.pushState, pushState);
  assert.equal(pageWindow.history.replaceState, replaceState);
  assert.equal(eventListeners.get('popstate').size, 1);
  assert.equal(pageWindow.__media.find(), video);
  const allMedia = pageWindow.__media.findAll();
  assert.equal(allMedia.length, 2);
  assert.equal(allMedia[0], video);
  const snapshot = pageWindow.__media.snapshot(video);
  assert.equal(snapshot.playing, true);
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.currentTime, 12);
  assert.equal(snapshot.duration, 120);
  assert.equal(snapshot.playbackRate, 1.25);
  assert.equal(snapshot.volume, 0.5);
  assert.equal(snapshot.muted, false);
  video.paused = true;
  for (const listener of documentListeners.get('pause') || []) listener({ type: 'pause', target: video });
  assert.equal(pageWindow.__mediaEvents.at(-1).snapshot.paused, true);
  audio.paused = false;
  audio.currentTime = 4;
  assert.equal(pageWindow.__media.find(), audio);

  const pageValue = await api.page.execute((key, suffix) => ({
    title: window[key].title,
    count: window[key].count,
    suffix,
  }), ['someApplicationState', '!']);
  assert.deepEqual(pageValue, { title: 'Page-owned title', count: 3, suffix: '!' });
  assert.deepEqual(await api.page.execute((first, second) => [first, second, window.someApplicationState.count], ['a', 9]), ['a', 9, 3]);
  assert.equal(await api.page.execute(() => 42), 42);
  await assert.rejects(api.page.execute(() => { throw new TypeError('page boom'); }), (error) =>
    error.name === 'TypeError' && error.code === 'page_execution_error' && error.message === 'page boom',
  );
  assert.equal(fake.pageExecutions.length, 4);
  assert.deepEqual(fake.pageExecutions[0].target, { tabId: 41, documentIds: ['page-exec-doc'] });
  assert.equal(fake.pageExecutions[0].world, 'MAIN');
  assert.deepEqual(await api.net.fetch('https://api.example.com/v1/status'), {
    status: 200, ok: true, contentType: 'application/json', data: { ok: true },
  });
  assert.equal(await api.settings.get('showAlbum'), true);
  assert.deepEqual(await api.settings.getAll(), { showAlbum: true, displayMode: 'artist' });
  await assert.rejects(api.settings.get('missingSetting'), (error) => error.code === 'invalid_setting_id');
  const settingsEvent = {
    type: 'CHUDPRESENCE_ACTIVITY_SETTINGS_CHANGED', activityId: 'sample-activity', activityVersion: '1.0.0',
    settingId: 'displayMode', value: 'album', settings: { showAlbum: true, displayMode: 'album' },
  };
  for (const listener of runtimeListeners) listener(settingsEvent);
  for (const listener of runtimeListeners) listener({ ...settingsEvent, activityId: 'other-activity' });
  assert.equal(pageWindow.__settingChanges.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(pageWindow.__settingChanges[0])), {
    id: 'displayMode', value: 'album', settings: { showAlbum: true, displayMode: 'album' },
  });
  await Promise.all([...runtimeListeners].map((listener) => listener({
    type: 'CHUDPRESENCE_ACTIVITY_UPGRADE', activityId: 'sample-activity', activityVersion: '1.0.0',
    fromVersion: '0.9.0', toVersion: '1.0.0',
  })));
  assert.deepEqual(JSON.parse(JSON.stringify(pageWindow.__upgradeEvents)), [{ fromVersion: '0.9.0', toVersion: '1.0.0' }]);
  await Promise.all([...runtimeListeners].map((listener) => listener({
    type: 'CHUDPRESENCE_ACTIVITY_UPGRADE', activityId: 'sample-activity', activityVersion: '1.0.0',
    fromVersion: '0.9.0', toVersion: '1.0.0',
  })));
  assert.equal(pageWindow.__upgradeEvents.length, 1);
  await Promise.all([...runtimeListeners].map((listener) => listener({
    type: 'CHUDPRESENCE_ACTIVITY_UPGRADE', activityId: 'other-activity', activityVersion: '1.0.0',
    fromVersion: '0.9.0', toVersion: '1.0.0',
  })));
  assert.equal(pageWindow.__upgradeEvents.length, 1);

  const waitingForElement = api.dom.waitFor('.late', { timeoutMs: 500 });
  const lateElement = {
    nodeType: 1,
    selector: '.late',
    matches(selector) { return selector === this.selector; },
    querySelectorAll() { return []; },
  };
  domElements.push(lateElement);
  for (const observer of [...observers]) {
    if (observer.target === document) observer.callback([{ type: 'childList', addedNodes: [lateElement] }]);
  }
  assert.equal(await waitingForElement, lateElement);
  const observedElements = [];
  const stopObserving = api.dom.observe('.item', (node) => observedElements.push(node), { immediate: false });
  const itemElement = {
    nodeType: 1,
    selector: '.item',
    matches(selector) { return selector === this.selector; },
    querySelectorAll() { return []; },
  };
  domElements.push(itemElement);
  const itemObserver = [...observers].find((observer) => observer.target === document && !observer.disconnected);
  itemObserver.callback([{ type: 'childList', addedNodes: [itemElement] }]);
  assert.deepEqual(observedElements, [itemElement]);
  stopObserving();
  assert.equal(itemObserver.disconnected, true);
  await assert.rejects(api.dom.waitFor('.never', { timeoutMs: 1 }), (error) => error.name === 'TimeoutError' && error.code === 'timeout');
  const cancelController = new AbortController();
  const abortedWait = assert.rejects(api.dom.waitFor('.also-never', { signal: cancelController.signal }),
    (error) => error.name === 'AbortError' && error.code === 'aborted');
  cancelController.abort();
  await abortedWait;
  await api.log.info('Activity started', {
    access_token: 'discord-access-token-value',
    cookie: 'session-cookie-value',
    route: 'https://service.example/watch?id=secret',
  });
  const activityStatus = (await manager.listInstalled())[0];
  assert.deepEqual(activityStatus.activityLogs[0].args, [
    'Activity started',
    { access_token: '[redacted]', cookie: '[redacted]', route: 'https://service.example/watch' },
  ]);
  assert.equal(activityStatus.activityLogs[0].activityId, 'sample-activity');
  assert.equal(activityStatus.activityLogs[0].activityVersion, '1.0.0');
  assert.equal(activityStatus.activityLogs[0].tabId, 41);
  assert.equal(activityStatus.activityLogs[0].frameId, 0);
  assert.equal(typeof activityStatus.activityLogs[0].timestamp, 'string');

  await api.report(activityReport('A report'));
  await api.clear();
  assert.deepEqual(calls.map((message) => message.operation), [
    'page.execute', 'page.execute', 'page.execute', 'page.execute', 'net.fetch',
    'settings.get', 'settings.getAll', 'settings.get', 'lifecycle.upgradeComplete', 'log.write', 'presence.report', 'presence.clear',
  ]);
  assert.deepEqual(calls.find((message) => message.operation === 'presence.report').payload.report, activityReport('A report'));
  assert.equal(calls.every((message) => message.type === 'CHUDPRESENCE_ACTIVITY_REQUEST'), true);

  await new Promise((resolve) => setTimeout(resolve, 18));
  const ticksAtTeardown = pageWindow.__ticks;
  for (const listener of runtimeListeners) listener({
    type: 'CHUDPRESENCE_ACTIVITY_ABORT', activityId: 'sample-activity', activityVersion: '1.0.0', reason: 'disabled',
  });
  assert.equal(pageWindow.__capturedSignal.aborted, true);
  assert.equal(pageWindow.__cleanupCount, 1);
  assert.equal(documentListeners.get('pause').size, 0);
  assert.equal(observers.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(pageWindow.__ticks, ticksAtTeardown);
  for (const listener of eventListeners.get('pagehide') || []) listener({ type: 'pagehide' });
  assert.equal(pageWindow.__cleanupCount, 1);
});

test('accepts reports only from the installed Activity world and declared site', async () => {
  const fake = createFakeApi();
  const reports = [];
  const manager = new ActivityManager({ api: fake.api, onReport: (value) => reports.push(value) });
  await manager.install(activityPackage());
  const message = { ...activityRequest('presence.report', { report: activityReport('Episode') }), activityId: 'spoofed-id' };

  assert.deepEqual(await manager.handleUserScriptMessage(message, {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 4 },
    documentId: 'doc-a',
    url: 'https://example.com/watch/1',
  }), { ok: true, requestId: 'test-request', data: { accepted: true } });
  assert.equal(reports[0].track.activityId, 'sample-activity');
  assert.equal(reports[0].track.source, 'activity');
  assert.deepEqual(reports[0].track.playback, {
    state: 'playing', position: 0, duration: 0, live: false, rate: 1,
  });
  assert.equal(await manager.handleUserScriptMessage(message, {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 4 },
    url: 'https://elsewhere.example/watch/1',
  }), false);
  assert.equal(reports.length, 1);
});

test('excludes URLs declared by Activity excludeMatches', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  activity.metadata.excludeMatches = ['https://example.com/private/*'];
  await manager.install(activity);
  const accepted = await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }, 'public'), {
    userScriptWorldId: 'chudpresence.activity.sample-activity', tab: { id: 72 }, frameId: 0,
    documentId: 'public-doc', url: 'https://example.com/watch',
  });
  const excluded = await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }, 'private'), {
    userScriptWorldId: 'chudpresence.activity.sample-activity', tab: { id: 73 }, frameId: 0,
    documentId: 'private-doc', url: 'https://example.com/private/watch',
  });
  assert.equal(accepted.ok, true);
  assert.equal(excluded, false);
  assert.equal((await manager.listInstalled())[0].lastReport.tabId, 72);
});

test('executes page functions in the requesting Activity document and serializes results', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  activity.metadata.matches.push('https://discord.com/*');
  fake.permissions.add('https://discord.com/*');
  await manager.install(activity);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 12 }, frameId: 2, documentId: 'doc-a', url: 'https://example.com/watch/1',
  };
  const request = activityRequest('page.execute', {
    source: '(...args) => [window.someApplicationState, args, 7, null]',
    argsJson: '["from activity", {"enabled":true}]',
  }, 'page-call');
  request.activityId = 'spoofed-activity';
  request.payload.activityId = 'also-spoofed';
  assert.deepEqual(await manager.handleUserScriptMessage(request, sender), {
    ok: true,
    requestId: 'page-call',
    data: { value: [{ title: 'Page-owned title', count: 3 }, ['from activity', { enabled: true }], 7, null] },
  });
  assert.deepEqual(fake.pageExecutions[0].target, { tabId: 12, documentIds: ['doc-a'] });
  assert.equal(fake.pageExecutions[0].world, 'MAIN');

  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('page.execute', {
    source: '() => window.someApplicationState.title', argsJson: '[]',
  }, 'primitive-result'), sender), {
    ok: true, requestId: 'primitive-result', data: { value: 'Page-owned title' },
  });
  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('page.execute', {
    source: '() => { throw new TypeError("page exploded"); }', argsJson: '[]',
  }, 'thrown-error'), sender), {
    ok: false,
    requestId: 'thrown-error',
    error: { code: 'page_execution_error', name: 'TypeError', message: 'page exploded' },
  });

  const injectionCount = fake.pageExecutions.length;
  assert.equal(await manager.handleUserScriptMessage(activityRequest('page.execute', {
    source: '() => 1', argsJson: '[]',
  }), { ...sender, userScriptWorldId: 'chudpresence.activity.other-activity' }), false);
  assert.equal(fake.pageExecutions.length, injectionCount);

  const protectedResult = await manager.handleUserScriptMessage(activityRequest('page.execute', {
    source: '() => window.localStorage', argsJson: '[]',
  }, 'protected-page'), { ...sender, url: 'https://discord.com/channels/1/2' });
  assert.deepEqual(protectedResult, {
    ok: false,
    requestId: 'protected-page',
    error: { code: 'protected_page', message: 'Page execution is unavailable on protected pages.' },
  });
  assert.equal(fake.pageExecutions.length, injectionCount);

  let finishExecution;
  fake.setNextPageExecutionResults(new Promise((resolve) => { finishExecution = resolve; }));
  const navigationPending = manager.handleUserScriptMessage(activityRequest('page.execute', {
    source: '() => 1', argsJson: '[]',
  }, 'navigation-pending'), sender);
  await Promise.resolve();
  finishExecution([{ documentId: 'doc-after-navigation', frameId: 2, result: '{"ok":true,"value":1}' }]);
  assert.deepEqual(await navigationPending, {
    ok: false,
    requestId: 'navigation-pending',
    error: { code: 'stale_document', message: 'The page navigated while execution was pending.' },
  });
});

test('brokers allowlisted cross-origin requests without credentials and records Activity identity', async () => {
  const fake = createFakeApi();
  fake.permissions.add('https://api.example.net/v1/*');
  let capturedUrl = '';
  let capturedOptions;
  fake.setFetchImplementation(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response('{"items":[1,2]}', {
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
  const manager = new ActivityManager({ api: fake.api, fetchImpl: fake.fetchImpl });
  const activity = activityPackage();
  activity.metadata.network = ['https://api.example.net/v1/*'];
  await manager.install(activity);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 27 }, frameId: 3, documentId: 'network-document',
    url: 'https://example.com/watch/1?session=sensitive',
  };
  const request = activityRequest('net.fetch', {
    url: 'https://api.example.net/v1/items?token=private',
    options: {
      method: 'POST',
      headers: { Authorization: 'Activity-owned-key' },
      json: { query: 'latest' },
    },
  }, 'network-call');
  request.activityId = 'spoofed-activity';
  assert.deepEqual(await manager.handleUserScriptMessage(request, sender), {
    ok: true,
    requestId: 'network-call',
    data: {
      status: 201,
      ok: true,
      contentType: 'application/json; charset=utf-8',
      data: { items: [1, 2] },
    },
  });
  assert.equal(capturedUrl, 'https://api.example.net/v1/items?token=private');
  assert.equal(capturedOptions.method, 'POST');
  assert.deepEqual(capturedOptions.headers, {
    Authorization: 'Activity-owned-key',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  assert.equal(capturedOptions.body, '{"query":"latest"}');
  assert.equal(capturedOptions.credentials, 'omit');
  assert.equal(capturedOptions.redirect, 'error');
  assert.equal(capturedOptions.referrerPolicy, 'no-referrer');
  const diagnostic = (await manager.listInstalled())[0].networkRequests[0];
  assert.equal(diagnostic.activityId, 'sample-activity');
  assert.equal(diagnostic.activityName, 'Sample Activity');
  assert.equal(diagnostic.tabId, 27);
  assert.equal(diagnostic.frameId, 3);
  assert.equal(diagnostic.documentId, 'network-document');
  assert.equal(diagnostic.senderUrl, 'https://example.com/watch/1');
  assert.equal(diagnostic.url, 'https://api.example.net/v1/items');
  assert.equal(diagnostic.state, 'complete');
  assert.equal(diagnostic.status, 201);
});

test('restricts network URLs, response size, and timeout', async () => {
  const fake = createFakeApi();
  fake.permissions.add('https://api.example.net/*');
  const manager = new ActivityManager({ api: fake.api, fetchImpl: fake.fetchImpl });
  const activity = activityPackage();
  activity.metadata.network = ['https://api.example.net/*'];
  await manager.install(activity);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 28 }, frameId: 0, documentId: 'network-document', url: 'https://example.com/watch/1',
  };
  const request = (url, options = {}, requestId = 'network-error') =>
    manager.handleUserScriptMessage(activityRequest('net.fetch', { url, options }, requestId), sender);

  assert.deepEqual(await request('http://api.example.net/data'), {
    ok: false, requestId: 'network-error',
    error: { code: 'invalid_url', name: 'TypeError', message: 'Network URLs must be HTTPS and cannot contain credentials or fragments.' },
  });
  assert.deepEqual(await request('https://unlisted.example.org/data', {}, 'unlisted-origin'), {
    ok: false, requestId: 'unlisted-origin',
    error: { code: 'origin_not_declared', name: 'TypeError', message: 'This network origin is not declared in the Activity metadata.' },
  });
  assert.deepEqual(await request('https://discord.com/api/users/@me', {}, 'discord-endpoint'), {
    ok: false, requestId: 'discord-endpoint',
    error: { code: 'protected_endpoint', name: 'TypeError', message: 'Discord network endpoints are reserved for extension core.' },
  });

  fake.setFetchImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
  const oversized = await request('https://api.example.net/data', { responseType: 'text' }, 'oversized-response');
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'response_too_large');

  let capturedSignal;
  fake.setFetchImplementation((_url, options) => {
    capturedSignal = options.signal;
    return new Promise(() => {});
  });
  const timedOut = await request('https://api.example.net/slow', { timeoutMs: 100 }, 'timed-out');
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'timeout');
  assert.equal(capturedSignal.aborted, true);
  const diagnostic = (await manager.listInstalled())[0].networkRequests;
  assert.equal(diagnostic.find((item) => item.requestId === 'oversized-response').errorCode, 'response_too_large');
  assert.equal(diagnostic.find((item) => item.requestId === 'timed-out').errorCode, 'timeout');
});

test('limits concurrent network work per Activity', async () => {
  const fake = createFakeApi();
  fake.permissions.add('https://api.example.net/*');
  const pendingFetches = [];
  fake.setFetchImplementation(() => new Promise((resolve) => pendingFetches.push(resolve)));
  const manager = new ActivityManager({ api: fake.api, fetchImpl: fake.fetchImpl });
  const activity = activityPackage();
  activity.metadata.network = ['https://api.example.net/*'];
  await manager.install(activity);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 29 }, frameId: 0, documentId: 'network-document', url: 'https://example.com/watch/1',
  };
  const request = (requestId) => manager.handleUserScriptMessage(activityRequest('net.fetch', {
    url: 'https://api.example.net/data',
  }, requestId), sender);
  const first = request('concurrent-1');
  await new Promise((resolve) => setImmediate(resolve));
  const second = request('concurrent-2');
  await new Promise((resolve) => setImmediate(resolve));
  const third = await request('concurrent-3');
  assert.equal(pendingFetches.length, 2);
  assert.equal(third.error.code, 'network_busy');
  for (const resolve of pendingFetches) resolve(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('returns structured errors for invalid reports and unsupported runtime requests', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 5 }, documentId: 'doc-a', url: 'https://example.com/watch/1',
  };
  assert.deepEqual(await manager.handleUserScriptMessage(
    activityRequest('presence.report', { report: { kind: 'video', media: { title: 'Bad' }, source: 'spoof' } }, 'bad-report'),
    sender,
  ), {
    ok: false,
    requestId: 'bad-report',
    error: { code: 'invalid_report', message: 'Activity report contains unsupported field source.' },
  });
  assert.deepEqual(await manager.handleUserScriptMessage(
    activityRequest('storage.get', { key: 'secret' }, 'unknown-request'),
    sender,
  ), {
    ok: true,
    requestId: 'unknown-request',
    data: { value: null },
  });
  assert.deepEqual(await manager.handleUserScriptMessage(
    activityRequest('unsupported.operation', {}, 'unsupported-request'),
    sender,
  ), {
    ok: false,
    requestId: 'unsupported-request',
    error: { code: 'unsupported_operation', message: 'This Activity runtime operation is not supported.' },
  });
});

test('isolates Activity storage and preserves it across updates while removing it on uninstall', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activityA = activityPackage();
  const activityB = activityPackage();
  activityB.metadata.id = 'other-activity';
  activityB.metadata.name = 'Other Activity';
  await manager.install(activityA);
  await manager.install(activityB);
  const sender = (id) => ({
    userScriptWorldId: `chudpresence.activity.${id}`,
    tab: { id: 51 }, frameId: 0, documentId: `${id}-document`, url: 'https://example.com/watch/1',
  });
  const request = (activityId, operation, payload = {}, requestId = `${activityId}-${operation}`) =>
    manager.handleUserScriptMessage(activityRequest(operation, payload, requestId), sender(activityId));

  assert.deepEqual(await request('sample-activity', 'storage.set', { key: 'token', value: { choice: 'A' } }), {
    ok: true, requestId: 'sample-activity-storage.set', data: { value: true },
  });
  assert.deepEqual(await request('sample-activity', 'storage.get', { key: 'token' }), {
    ok: true, requestId: 'sample-activity-storage.get', data: { value: { choice: 'A' } },
  });
  assert.deepEqual(await request('other-activity', 'storage.get', { key: 'token' }), {
    ok: true, requestId: 'other-activity-storage.get', data: { value: null },
  });

  const spoofed = await request('sample-activity', 'storage.set', {
    activityId: 'other-activity', key: 'token', value: 'still A',
  }, 'spoofed-storage-identity');
  assert.equal(spoofed.ok, true);
  assert.equal((await request('other-activity', 'storage.get', { key: 'token' })).data.value, null);

  const updated = activityPackage();
  updated.metadata.version = '1.1.0';
  await manager.install(updated);
  assert.deepEqual((await request('sample-activity', 'storage.get', { key: 'token' })).data.value, 'still A');

  assert.equal((await request('sample-activity', 'storage.remove', { key: 'token' })).data.value, true);
  assert.equal((await request('sample-activity', 'storage.remove', { key: 'token' })).data.value, false);
  await request('sample-activity', 'storage.set', { key: 'one', value: 1 });
  await request('sample-activity', 'storage.set', { key: 'two', value: 2 });
  assert.equal((await request('sample-activity', 'storage.clear')).data.value, 2);
  assert.equal((await request('sample-activity', 'storage.clear')).data.value, 0);
  await request('sample-activity', 'storage.set', { key: 'kept-until-uninstall', value: true });

  await manager.remove('sample-activity');
  assert.equal(Object.keys(fake.data).some((key) => key.startsWith('chudpresence.activityStorage:sample-activity:')), false);
  assert.equal(Object.keys(fake.data).some((key) => key.startsWith('chudpresence.activityStorage:other-activity:')), false);
});

test('enforces per-Activity storage quota and returns structured storage failures', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 52 }, frameId: 0, documentId: 'storage-document', url: 'https://example.com/watch/1',
  };
  const request = (operation, payload, requestId) => manager.handleUserScriptMessage(
    activityRequest(operation, payload, requestId), sender,
  );

  const tooLarge = await request('storage.set', { key: 'large', value: 'x'.repeat(70 * 1024) }, 'over-quota');
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, 'storage_quota_exceeded');
  assert.equal((await request('storage.get', { key: 'large' }, 'large-read')).data.value, null);

  fake.failNextWrite();
  const failedWrite = await request('storage.set', { key: 'write-fails', value: 'value' }, 'storage-write-failure');
  assert.deepEqual(failedWrite, {
    ok: false,
    requestId: 'storage-write-failure',
    error: { code: 'storage_error', name: 'Error', message: 'Simulated storage failure' },
  });

  const invalidKey = await request('storage.get', { key: '\ud800' }, 'invalid-storage-key');
  assert.equal(invalidKey.ok, false);
  assert.equal(invalidKey.error.code, 'invalid_storage_key');
});

test('records report lifecycle diagnostics and bounds Activity logs', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 53 }, frameId: 0, documentId: 'diagnostic-document', url: 'https://example.com/watch?token=hidden',
  };
  const report = activityReport('access_token=should-not-be-visible');
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report }, 'diagnostic-report'), sender);
  let installed = (await manager.listInstalled())[0];
  assert.match(installed.rawReport.media.title, /\[redacted\]/);
  assert.match(installed.normalizedReport.media.title, /\[redacted\]/);
  assert.equal(installed.lastReport.senderUrl, 'https://example.com/watch');
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: { kind: 'unknown' } }, 'diagnostic-error'), sender);
  installed = (await manager.listInstalled())[0];
  assert.equal(installed.lastError.code, 'invalid_report');
  await manager.handleUserScriptMessage(activityRequest('presence.clear', {}, 'diagnostic-clear'), sender);
  installed = (await manager.listInstalled())[0];
  assert.equal(installed.lastClear.reason, 'cleared');

  for (let index = 0; index < 205; index += 1) {
    await manager.handleUserScriptMessage(activityRequest('log.write', {
      level: 'debug', args: [`entry-${index}`],
    }, `log-${index}`), {
      ...sender,
      tab: { id: 1000 + index },
      documentId: `log-document-${index}`,
    });
  }
  assert.equal(manager.activityLogs.length, 200);
  installed = (await manager.listInstalled())[0];
  assert.equal(installed.activityLogs.length, 10);
  assert.equal(installed.activityLogs[0].args[0], 'entry-195');
  assert.equal(installed.activityLogs.at(-1).args[0], 'entry-204');
  const state = await manager.status();
  assert.deepEqual(state.grantedOrigins, ['https://example.com/*']);
});

test('reloads an installed Activity in its active document without restarting Firefox', async () => {
  const fake = createFakeApi();
  const cleared = [];
  const manager = new ActivityManager({ api: fake.api, onClear: (...args) => cleared.push(args) });
  await manager.install(activityPackage());
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 54 }, frameId: 0, documentId: 'reload-document', url: 'https://example.com/watch',
  };
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }), sender);
  await connectActivity(fake, manager, sender);
  const result = await manager.reload('sample-activity');
  assert.deepEqual(result, { id: 'sample-activity', reloadedFrames: 1 });
  const injection = fake.pageExecutions.at(-1);
  assert.equal(injection.world, 'USER_SCRIPT');
  assert.equal(injection.worldId, 'chudpresence.activity.sample-activity');
  assert.deepEqual(injection.target, { tabId: 54, documentIds: ['reload-document'] });
  assert.equal(fake.sentMessages.at(-1).message.reason, 'reloaded');
  assert.equal(cleared.length, 1);
});

test('marks installed Activities that need a newer extension as incompatible', async () => {
  const fake = createFakeApi();
  const activity = activityPackage();
  activity.metadata.minExtensionVersion = '1.12.0';
  await fake.api.storage.local.set({
    installedActivities: {
      'sample-activity': {
        metadata: activity.metadata,
        code: activity.source,
        enabled: true,
        source: { type: 'repository' },
      },
    },
  });
  const manager = new ActivityManager({ api: fake.api });
  await manager.restoreAll();
  const [record] = await manager.listInstalled();
  assert.equal(record.status, 'incompatible');
  assert.equal(record.compatibilityStatus, 'Requires ChudPresence v1.12.0 or newer');
  assert.equal(fake.scripts.has('chudpresence-activity-sample-activity'), false);
});

test('stores immutable repository provenance after rechecking package hashes', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  const metadataSource = JSON.stringify(activity.metadata);
  const hash = async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const provenance = {
    repository: 'ChudForks/ChudPresence-Activities',
    revision: 'c'.repeat(40),
    codeSha256: await hash(activity.source),
    metadataSha256: await hash(metadataSource),
  };
  await manager.install({ ...activity, metadataSource, sourceType: 'repository', provenance });
  assert.deepEqual((await manager.get('sample-activity')).source, {
    type: 'repository', ...provenance,
  });
  await assert.rejects(manager.install({
    ...activity,
    metadataSource,
    sourceType: 'repository',
    provenance: { ...provenance, codeSha256: '0'.repeat(64) },
  }), /code no longer matches/);
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
    ...activityRequest('presence.report', { report: activityReport('Current page') }),
  }, { ...baseSender, documentId: 'new-document' });

  assert.deepEqual(await manager.handleUserScriptMessage(
    activityRequest('presence.clear', {}, 'old-clear'),
    { ...baseSender, url: 'https://example.com/old-page', documentId: 'old-document' },
  ), { ok: true, requestId: 'old-clear', data: { cleared: false, stale: true } });
  assert.equal((await manager.listInstalled())[0].status, 'detected');
  assert.deepEqual(cleared, []);

  await manager.handleUserScriptMessage(activityRequest('presence.clear', {}, 'new-clear'), {
    ...baseSender,
    documentId: 'new-document',
  });
  assert.equal((await manager.listInstalled())[0].status, 'waiting');
  assert.equal(cleared.length, 1);
});

test('supports top and embedded player frames and rejects reports from replaced child documents', async () => {
  const fake = createFakeApi();
  fake.permissions.add('https://player.example.com/*');
  const reports = [];
  const clears = [];
  const manager = new ActivityManager({
    api: fake.api,
    onReport: (report) => reports.push(report),
    onClear: (...args) => clears.push(args),
  });
  const activity = activityPackage();
  activity.metadata.matches.push('https://player.example.com/*');
  activity.metadata.frames = 'all';
  await manager.install(activity);
  const registered = fake.scripts.get('chudpresence-activity-sample-activity');
  assert.equal(registered.allFrames, true);
  assert.deepEqual(registered.matches, ['https://example.com/*', 'https://player.example.com/*']);

  const topSender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 21 }, frameId: 0, documentId: 'top-document', url: 'https://example.com/watch/1',
  };
  const childSender = {
    ...topSender,
    frameId: 4,
    documentId: 'child-document-a',
    url: 'https://player.example.com/embed/1',
  };
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Parent service'),
  }), topSender)).data.accepted, true);
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Embedded playback'),
  }), childSender)).data.accepted, true);
  assert.equal(reports[1].frameId, 4);
  assert.equal(reports[1].senderUrl, 'https://player.example.com/embed/1');
  assert.deepEqual((await manager.listInstalled())[0].activeFrames.map((frame) => frame.frameId).sort(), [0, 4]);

  const replacementSender = { ...childSender, documentId: 'child-document-b' };
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Replacement playback'),
  }), replacementSender)).data.accepted, true);
  assert.deepEqual(clears[0], ['sample-activity', 21, 'child-document-a', 4]);

  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Late old playback'),
  }, 'late-report'), childSender), {
    ok: false,
    requestId: 'late-report',
    error: { code: 'stale_document', message: 'This Activity document has already been replaced.' },
  });
  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('presence.clear', {}, 'late-clear'), childSender), {
    ok: true,
    requestId: 'late-clear',
    data: { cleared: false, stale: true },
  });
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.clear', {}, 'current-clear'), replacementSender)).data.cleared, true);
  assert.equal((await manager.listInstalled())[0].status, 'detected');

  const childAfterParentNavigation = { ...childSender, documentId: 'child-document-c' };
  await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Child before parent navigation'),
  }), childAfterParentNavigation);
  const nextTopSender = { ...topSender, documentId: 'top-document-next' };
  await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Next parent page'),
  }), nextTopSender);
  const status = (await manager.listInstalled())[0];
  assert.deepEqual(status.activeFrames.map((frame) => frame.frameId), [0]);
  const retiredChild = status.frameContexts.find((frame) => frame.frameId === 4);
  assert.equal(retiredChild.state, 'retired');
  assert.equal(retiredChild.documentId, 'child-document-c');
  assert.deepEqual(retiredChild.retiredDocumentIds, ['child-document-c']);
  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Late child from old parent'),
  }, 'late-parent-child'), childAfterParentNavigation), {
    ok: false,
    requestId: 'late-parent-child',
    error: { code: 'stale_document', message: 'This Activity document has already been replaced.' },
  });
});

test('tab navigation retires reports from every old Activity frame', async () => {
  const fake = createFakeApi();
  fake.permissions.add('https://player.example.com/*');
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  activity.metadata.matches.push('https://player.example.com/*');
  activity.metadata.frames = 'all';
  await manager.install(activity);
  const base = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 23 }, url: 'https://example.com/watch/1',
  };
  const top = { ...base, frameId: 0, documentId: 'tab-old-top' };
  const child = { ...base, frameId: 2, documentId: 'tab-old-child', url: 'https://player.example.com/embed/1' };
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport('old top') }), top);
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport('old child') }), child);

  assert.equal(await manager.invalidateTab(23), 2);
  const status = (await manager.listInstalled())[0];
  assert.equal(status.status, 'waiting');
  assert.equal(status.frameContexts.filter((frame) => frame.state === 'retired').length, 2);
  assert.deepEqual(await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('late child'),
  }, 'late-tab-child'), child), {
    ok: false,
    requestId: 'late-tab-child',
    error: { code: 'stale_document', message: 'This Activity document has already been replaced.' },
  });
});

test('a queue-style URL update keeps the same document eligible to report', async () => {
  const fake = createFakeApi();
  const reports = [];
  const manager = new ActivityManager({ api: fake.api, onReport: (report) => reports.push(report) });
  await manager.install(activityPackage());
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 24 }, frameId: 0, documentId: 'same-document',
    url: 'https://example.com/watch?track=first',
  };
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('First track'),
  }), sender)).ok, true);

  // Firefox may report a History API URL change without replacing the page.
  assert.equal(shouldInvalidateActivityTab({ url: 'https://example.com/watch?track=next' }), false);
  const nextSender = { ...sender, url: 'https://example.com/watch?track=next' };
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Next track'),
  }), nextSender)).ok, true);
  assert.equal(reports.at(-1).track.media.title, 'Next track');

  assert.equal(shouldInvalidateActivityTab({ status: 'loading', url: 'https://example.com/new-page' }), true);
  await manager.invalidateTab(24);
  assert.equal((await manager.handleUserScriptMessage(activityRequest('presence.report', {
    report: activityReport('Old document'),
  }), nextSender)).error.code, 'stale_document');
  assert.equal(shouldInvalidateActivityTab({ discarded: true }), true);
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

test('notifies active Activity documents before disable, update, and uninstall', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 6 }, frameId: 3, documentId: 'doc-a', url: 'https://example.com/watch/1',
  };
  await manager.install(activityPackage());
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }), sender);
  await connectActivity(fake, manager, sender);
  await manager.install(activityPackage());
  const updateNotice = fake.sentMessages.find((item) => item.message.reason === 'updated');
  assert.ok(updateNotice);
  assert.deepEqual(updateNotice.options, { documentId: 'doc-a' });
  assert.equal(fake.sentMessages.filter((item) => item.message.reason === 'updated').length, 1);

  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }, 'report-2'), sender);
  await connectActivity(fake, manager, sender);
  await manager.setEnabled('sample-activity', false);
  assert.equal(fake.sentMessages.at(-1).message.reason, 'disabled');

  await manager.setEnabled('sample-activity', true);
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }, 'report-3'), sender);
  await connectActivity(fake, manager, sender);
  await manager.remove('sample-activity');
  assert.equal(fake.sentMessages.at(-1).message.reason, 'uninstalled');
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

test('persists declarative Activity settings, rejects invalid values, and defaults values invalid under a new schema', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  activity.metadata.settings = [
    { id: 'showAlbum', type: 'boolean', label: 'Show album', default: true },
    { id: 'displayMode', type: 'select', label: 'Display mode', default: 'artist', options: [
      { label: 'Artist', value: 'artist' }, { label: 'Album', value: 'album' },
    ] },
    { id: 'prefix', type: 'string', label: 'Prefix', default: '', maxLength: 20 },
    { id: 'volume', type: 'range', label: 'Volume', default: 50, min: 0, max: 100, step: 5 },
    { id: 'offset', type: 'number', label: 'Offset', default: 0, min: -10, max: 10 },
  ];
  await manager.install(activity);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 65 }, frameId: 0, documentId: 'settings-document', url: 'https://example.com/watch',
  };
  await connectActivity(fake, manager, sender);
  assert.deepEqual((await manager.listInstalled())[0].settingValues, {
    showAlbum: true, displayMode: 'artist', prefix: '', volume: 50, offset: 0,
  });

  await manager.setActivitySetting('sample-activity', 'showAlbum', false);
  assert.equal(fake.sentMessages.at(-1).message.type, 'CHUDPRESENCE_ACTIVITY_SETTINGS_CHANGED');
  assert.deepEqual(fake.sentMessages.at(-1).message.settings, {
    showAlbum: false, displayMode: 'artist', prefix: '', volume: 50, offset: 0,
  });
  await manager.setActivitySetting('sample-activity', 'displayMode', 'album');
  await manager.setActivitySetting('sample-activity', 'prefix', '♫ ');
  await manager.setActivitySetting('sample-activity', 'volume', 75);
  await manager.setActivitySetting('sample-activity', 'offset', -2.5);
  await assert.rejects(manager.setActivitySetting('sample-activity', 'displayMode', 'unknown'), /invalid/);
  await assert.rejects(manager.setActivitySetting('sample-activity', 'volume', 74), /invalid/);
  await assert.rejects(manager.setActivitySetting('sample-activity', 'prefix', 'x'.repeat(21)), /invalid/);
  assert.deepEqual(manager.settingsFor('sample-activity'), {
    showAlbum: false, displayMode: 'album', prefix: '♫ ', volume: 75, offset: -2.5,
  });

  const updated = structuredClone(activity);
  updated.metadata.version = '1.1.0';
  await manager.install(updated);
  assert.equal(manager.settingsFor('sample-activity').displayMode, 'album');
  updated.metadata.version = '1.2.0';
  updated.metadata.settings[1] = {
    id: 'displayMode', type: 'select', label: 'Display mode', default: 'artist',
    options: [{ label: 'Artist', value: 'artist' }, { label: 'Title', value: 'title' }],
  };
  await manager.install(updated);
  assert.equal(manager.settingsFor('sample-activity').displayMode, 'artist');
  assert.equal(manager.settingsFor('sample-activity').showAlbum, false);
});

test('runs one persisted upgrade transition after a version change and records migration failures', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 70 }, frameId: 0, documentId: 'upgrade-doc', url: 'https://example.com/watch',
  };
  await manager.install(activityPackage());
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }), sender);
  await connectActivity(fake, manager, sender);

  const updated = activityPackage();
  updated.metadata.version = '1.1.0';
  await manager.install(updated);
  assert.deepEqual((await manager.get('sample-activity')).pendingUpgrade, {
    fromVersion: '1.0.0', toVersion: '1.1.0',
  });

  const newSender = { ...sender, documentId: 'upgrade-doc-new' };
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }, 'new-version-report'), newSender);
  await connectActivity(fake, manager, newSender, '1.1.0');
  const upgradeNotice = fake.sentMessages.find((item) => item.message.type === 'CHUDPRESENCE_ACTIVITY_UPGRADE');
  assert.ok(upgradeNotice);
  assert.deepEqual(upgradeNotice.message, {
    type: 'CHUDPRESENCE_ACTIVITY_UPGRADE', activityId: 'sample-activity', activityVersion: '1.1.0',
    fromVersion: '1.0.0', toVersion: '1.1.0',
  });
  assert.deepEqual(upgradeNotice.options, { documentId: 'upgrade-doc-new' });

  const failed = await manager.handleUserScriptMessage(activityRequest('lifecycle.upgradeError', {
    fromVersion: '1.0.0', toVersion: '1.1.0', name: 'MigrationError', message: 'could not migrate key',
  }, 'migration-failed'), newSender);
  assert.equal(failed.ok, true);
  assert.deepEqual((await manager.listInstalled())[0].pendingUpgrade, { fromVersion: '1.0.0', toVersion: '1.1.0' });
  assert.equal((await manager.listInstalled())[0].lastError.code, 'upgrade_migration_failed');

  const completed = await manager.handleUserScriptMessage(activityRequest('lifecycle.upgradeComplete', {
    fromVersion: '1.0.0', toVersion: '1.1.0',
  }, 'migration-complete'), newSender);
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.data, { completed: true, pending: false });
  assert.equal((await manager.get('sample-activity')).pendingUpgrade, undefined);
  assert.equal((await manager.listInstalled())[0].lastUpgrade.status, 'completed');

  const restartedManager = new ActivityManager({ api: fake.api });
  await restartedManager.restoreAll();
  assert.equal((await restartedManager.get('sample-activity')).pendingUpgrade, undefined);
  assert.equal(fake.sentMessages.filter((item) => item.message.type === 'CHUDPRESENCE_ACTIVITY_UPGRADE').length, 1);
});

test('does not create or dispatch an upgrade transition during ordinary restart or same-version install', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  await manager.install(activityPackage());
  const restartedManager = new ActivityManager({ api: fake.api });
  await restartedManager.restoreAll();
  const sameVersion = await restartedManager.install(activityPackage());
  assert.equal(sameVersion.version, '1.0.0');
  assert.equal((await restartedManager.get('sample-activity')).pendingUpgrade, undefined);
  await restartedManager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }), {
    userScriptWorldId: 'chudpresence.activity.sample-activity', tab: { id: 71 }, frameId: 0,
    documentId: 'restart-doc', url: 'https://example.com/watch',
  });
  assert.equal(fake.sentMessages.some((item) => item.message.type === 'CHUDPRESENCE_ACTIVITY_UPGRADE'), false);
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

test('keeps the previous Activity operational when an update fails before commit', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const previous = activityPackage();
  previous.source = 'globalThis.__activityRevision = "old";';
  await manager.install(previous);
  const sender = {
    userScriptWorldId: 'chudpresence.activity.sample-activity',
    tab: { id: 58 }, frameId: 0, documentId: 'update-document', url: 'https://example.com/watch',
  };
  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport() }), sender);

  const changed = activityPackage();
  changed.metadata.version = '1.1.0';
  changed.source = 'globalThis.__activityRevision = "new";';
  fake.failNextScriptUpdate();
  await assert.rejects(manager.install(changed), /Simulated script update failure/);
  assert.equal((await manager.get('sample-activity')).code, previous.source);
  assert.match(fake.scripts.get('chudpresence-activity-sample-activity').js[0].code, /__activityRevision = "old"/);
  assert.equal(fake.pageExecutions.at(-1).world, 'USER_SCRIPT');

  await manager.handleUserScriptMessage(activityRequest('presence.report', { report: activityReport('Old still running') }), sender);
  fake.failNextWrite();
  await assert.rejects(manager.install(changed), /Simulated storage failure/);
  assert.equal((await manager.get('sample-activity')).code, previous.source);
  assert.match(fake.scripts.get('chudpresence-activity-sample-activity').js[0].code, /__activityRevision = "old"/);
  const accepted = await manager.handleUserScriptMessage(
    activityRequest('presence.report', { report: activityReport('Old is operational') }), sender,
  );
  assert.equal(accepted.ok, true);
});

test('removes host permissions made obsolete by a committed update', async () => {
  const fake = createFakeApi();
  const manager = new ActivityManager({ api: fake.api });
  const activity = activityPackage();
  await manager.install(activity);
  fake.permissions.add('https://new.example.net/*');
  const updated = activityPackage();
  updated.metadata.version = '1.1.0';
  updated.metadata.matches = ['https://new.example.net/*'];
  await manager.install(updated);
  assert.equal(fake.permissions.has('https://example.com/*'), false);
  assert.equal(fake.permissions.has('https://new.example.net/*'), true);
});
