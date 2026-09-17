import { selectActivity } from './core/activity.js';
import { ActivityRegistry } from './core/activity-registry.js';
import { createPresenceIntent } from './core/presence.js';
import {
  applicationIdForSource,
  DEFAULT_SETTINGS,
  isTrackAllowed,
  LEGACY_APPLICATION_ID_SETTINGS,
  LEGACY_DETAIL_SETTINGS,
  normalizeSettings,
  presenceDetailsForSource,
} from './core/settings.js';
import { presencePublisher } from './platform/presence-publisher.js';
import { EXTENSION_NAME } from './core/branding.js';

const activityRegistry = new ActivityRegistry();
let activeTabId = null;
let settings = { ...DEFAULT_SETTINGS };
let delivery = presencePublisher.status();
let pushTimer = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  await chrome.storage.local.set(normalizeSettings(stored));
  await chrome.storage.local.remove([
    'bridgeUrl',
    'discordClientId',
    ...LEGACY_APPLICATION_ID_SETTINGS,
    ...LEGACY_DETAIL_SETTINGS,
  ]);
});

async function loadSettings() {
  settings = normalizeSettings(await chrome.storage.local.get(null));
}

function currentTrack() {
  const eligible = new Map(
    [...activityRegistry.tracks()].filter(([, track]) => isTrackAllowed(track, settings)),
  );
  const selected = selectActivity(eligible, activeTabId);
  activeTabId = selected.tabId;
  return selected.track;
}

function setAction(track) {
  const suffix = track?.artist ? ` — ${track.artist}` : '';
  chrome.action.setTitle({ title: track?.title ? `${track.title}${suffix}` : EXTENSION_NAME });
}

async function publishCurrentActivity({ closing = false } = {}) {
  const track = currentTrack();
  setAction(track);
  const intent = createPresenceIntent(
    track,
    Date.now(),
    presenceDetailsForSource(track?.source, settings),
  );
  const applicationId = applicationIdForSource(track?.source, settings);
  delivery = await presencePublisher.publish(intent, applicationId, { closing });
}

async function connectDiscord() {
  delivery = await presencePublisher.connect();
  await publishCurrentActivity();
  return delivery;
}

async function disconnectDiscord() {
  delivery = await presencePublisher.disconnect();
  return delivery;
}

function schedulePublish() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = 0;
    publishCurrentActivity();
  }, 250);
}

function clearActiveTab(tabId) {
  if (activeTabId === tabId) activeTabId = null;
}

function pingRemaining() {
  for (const tabId of activityRegistry.tracks().keys()) {
    chrome.tabs.sendMessage(tabId, { type: 'FORCE_TICK' }).catch(() => {
      activityRegistry.clearTab(tabId);
      clearActiveTab(tabId);
      schedulePublish();
    });
  }
}

function onTabGone(tabId, { closing = false } = {}) {
  if (typeof tabId !== 'number') return;
  const known = activityRegistry.clearTab(tabId);
  clearActiveTab(tabId);
  if (!known) return;
  pingRemaining();
  publishCurrentActivity({ closing });
}

function onDocumentGone(tabId, documentId, { closing = false } = {}) {
  if (typeof tabId !== 'number') return;
  const known = activityRegistry.clearDocument(tabId, documentId);
  if (!known) return;
  clearActiveTab(tabId);
  pingRemaining();
  publishCurrentActivity({ closing });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const privilegedDiscordMessage = [
    'GET_DISCORD_SETUP',
    'CONNECT_DISCORD',
    'DISCONNECT_DISCORD',
  ].includes(message?.type);
  const sentByExtensionPage = String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (privilegedDiscordMessage && !sentByExtensionPage) {
    sendResponse({ ok: false, error: 'Discord account controls are only available on extension pages.' });
    return false;
  }

  if (message?.type === 'TRACK_UPDATE') {
    const tabId = sender.tab?.id;
    activityRegistry.update(tabId, sender.documentId, message.track);
    schedulePublish();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'TAB_CLOSING') {
    onDocumentGone(sender.tab?.id, sender.documentId, { closing: true });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'HEARTBEAT') {
    const tabId = sender.tab?.id;
    activityRegistry.heartbeat(tabId, sender.documentId);
    schedulePublish();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'GET_STATE') {
    delivery = presencePublisher.status();
    sendResponse({ settings, delivery, track: currentTrack() });
    return false;
  }

  if (message?.type === 'GET_DISCORD_SETUP') {
    presencePublisher.initialize()
      .then(async () => sendResponse({ ok: true, setup: await presencePublisher.setup(), delivery: presencePublisher.status() }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'CONNECT_DISCORD') {
    connectDiscord()
      .then(async () => sendResponse({ ok: true, delivery, setup: await presencePublisher.setup() }))
      .catch((error) => sendResponse({ ok: false, error: error.message, delivery: presencePublisher.status() }));
    return true;
  }

  if (message?.type === 'DISCONNECT_DISCORD') {
    disconnectDiscord()
      .then(async () => sendResponse({ ok: true, delivery, setup: await presencePublisher.setup() }))
      .catch((error) => sendResponse({ ok: false, error: error.message, delivery: presencePublisher.status() }));
    return true;
  }

  if (message?.type === 'SET_ENABLED') {
    settings.enabled = Boolean(message.enabled);
    chrome.storage.local.set({ enabled: settings.enabled });
    publishCurrentActivity()
      .then(() => sendResponse({ ok: true, settings }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'presence') return;
  const tabId = port.sender?.tab?.id;
  const documentId = port.sender?.documentId;
  port.onDisconnect.addListener(() => {
    if (typeof tabId !== 'number') return;
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (!tab || tab.discarded) onTabGone(tabId, { closing: true });
        else onDocumentGone(tabId, documentId);
      })
      .catch(() => onTabGone(tabId, { closing: true }));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => onTabGone(tabId, { closing: true }));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.discarded === true) {
    onTabGone(tabId);
    return;
  }

  // Navigation keeps the tab ID. Clear the old document's activity immediately
  // so the next supported site's first report can replace it without a timeout.
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    onTabGone(tabId);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const relevant = Object.keys(changes).some((key) => key in DEFAULT_SETTINGS);
  if (!relevant) return;
  loadSettings().then(publishCurrentActivity);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'discord-presence-renew') return;
  presencePublisher.renew().then((result) => {
    delivery = result;
  });
});

Promise.all([loadSettings(), presencePublisher.initialize()]).then(() => {
  delivery = presencePublisher.status();
});
