import { DEFAULT_SETTINGS, normalizeSettings, SERVICE_SETTINGS } from './core/settings.js';
import { DEFAULT_ACTIVITY_PREFERENCES } from './core/activity-settings.js';

const serviceUi = Object.freeze({
  youtube: {
    icon: 'assets/services/youtube.svg',
    description: 'Videos, Shorts, and live streams',
    statuses: [['app', 'YouTube'], ['creator', 'Creator / channel'], ['video', 'Video title']],
  },
  movies67: {
    icon: 'assets/services/movies67.svg',
    description: 'Movies and television',
    statuses: [['app', '67Movies'], ['series', 'Series'], ['episode', 'Episode']],
  },
  twitch: {
    icon: 'assets/services/twitch.svg',
    description: 'Live streams and videos on demand',
    statuses: [['app', 'Twitch'], ['streamer', 'Streamer'], ['stream', 'Stream title']],
  },
  kick: {
    icon: 'assets/services/kick.svg',
    description: 'Live streams and videos on demand',
    statuses: [['app', 'Kick'], ['streamer', 'Streamer'], ['stream', 'Stream title']],
  },
});

const activityView = document.getElementById('activity-view');
const settingsView = document.getElementById('settings-view');
const activityTab = document.getElementById('activity-tab');
const settingsTab = document.getElementById('settings-tab');
const form = document.getElementById('settings-form');
const saveStatus = document.getElementById('save-status');
const artEl = document.getElementById('art');
const artFallback = document.getElementById('art-fallback');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const kickerEl = document.getElementById('kicker');
const hintEl = document.getElementById('hint');
const presenceState = document.getElementById('presence-state');
const discordAction = document.getElementById('discord-action');
const settingsDiscordAction = document.getElementById('settings-discord-action');
const discordStatus = document.getElementById('discord-status');
const firefoxOAuthRedirect = document.getElementById('firefox-oauth-redirect');
let firefoxOAuthRedirectUrl = '';
const activeServiceIcon = document.getElementById('active-service-icon');
const serviceGrid = document.querySelector('.service-grid');
const activitySettingsSection = document.getElementById('activity-settings-section');
const activitySettings = document.getElementById('activity-settings');
let lastState = null;
let formHasLoaded = false;
let saveTimer = 0;
let installedActivities = [];

function sourceIcon(track) {
  if (track?.activityId) {
    return installedActivities.find((activity) => activity.id === track.activityId)?.icon || 'icons/icon32.png';
  }
  return serviceUi[track?.source]?.icon || 'icons/icon32.png';
}

function sourceName(track) {
  if (track?.activityName) return track.activityName;
  if (track?.source === 'movies67') return '67Movies';
  if (track?.source === 'crunchyroll') return 'Crunchyroll';
  if (track?.source === 'youtube') {
    if (track.kind === 'short') return 'YouTube Shorts';
    if (track.live || track.kind === 'live') return 'YouTube Live';
    return 'YouTube';
  }
  if (track?.source === 'twitch') return track.live || track.kind === 'live' ? 'Twitch Live' : 'Twitch';
  if (track?.source === 'kick') return track.live || track.kind === 'live' ? 'Kick Live' : 'Kick';
  return 'Playback';
}

function buildServiceSettings() {
  const container = document.getElementById('service-settings');
  const template = document.getElementById('service-settings-template');

  for (const [source, service] of Object.entries(SERVICE_SETTINGS)) {
    const ui = serviceUi[source];
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.service = source;
    card.querySelector('.service-summary-icon img').src = ui.icon;
    card.querySelector('.setting-copy strong').textContent = service.label;
    card.querySelector('.setting-copy small').textContent = ui.description;

    const master = card.querySelector('.service-master input');
    master.name = service.enabled;
    master.setAttribute('aria-label', `Share ${service.label} activity`);
    master.addEventListener('click', (event) => event.stopPropagation());

    for (const [settingType, settingName] of Object.entries({
      paused: service.paused,
      status: service.status,
      artwork: service.artwork,
      timestamps: service.timestamps,
      buttons: service.buttons,
    })) {
      const input = card.querySelector(`[data-setting="${settingType}"]`);
      input.name = settingName;
      if (input.tagName === 'SELECT') {
        for (const [value, label] of ui.statuses) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          input.append(option);
        }
      }
    }
    container.append(card);
  }
}

function showView(view) {
  const showSettings = view === 'settings';
  activityView.hidden = showSettings;
  settingsView.hidden = !showSettings;
  activityTab.classList.toggle('is-active', !showSettings);
  settingsTab.classList.toggle('is-active', showSettings);
  activityTab.setAttribute('aria-pressed', String(!showSettings));
  settingsTab.setAttribute('aria-pressed', String(showSettings));
  document.body.dataset.view = view;
  (showSettings ? settingsView : activityView).scrollTop = 0;
}

function updateServiceStates(settings) {
  for (const [source, service] of Object.entries(SERVICE_SETTINGS)) {
    const enabled = settings[service.enabled] !== false;
    document.querySelector(`.service-tile[data-service="${source}"]`)?.classList.toggle('enabled', enabled);
    document.querySelector(`.service-tile[data-service="${source}"]`)?.classList.toggle('disabled', !enabled);
    document.querySelector(`.service-settings-card[data-service="${source}"]`)?.classList.toggle('is-disabled', !enabled);
  }
}

function activityExtensionMessage(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || 'Could not update the Activity.');
    return response.result;
  });
}

function renderInstalledActivityTiles() {
  serviceGrid.querySelectorAll('[data-activity-id]').forEach((tile) => tile.remove());
  for (const activity of installedActivities) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `service-tile activity-service-tile ${activity.enabled ? 'enabled' : 'disabled'}`;
    tile.dataset.activityId = activity.id;
    tile.setAttribute('aria-label', `${activity.name}, ${activity.enabled ? 'enabled' : 'disabled'}. Open settings.`);
    const icon = document.createElement('img');
    icon.src = activity.icon || 'icons/icon32.png';
    icon.alt = '';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = activity.name;
    const status = document.createElement('small');
    status.textContent = activity.enabled ? 'Installed Activity' : 'Activity disabled';
    copy.append(name, status);
    tile.append(icon, copy, document.createElement('i'));
    tile.addEventListener('click', () => showActivitySettings(activity.id));
    serviceGrid.append(tile);
  }
}

function renderInstalledActivitySettings() {
  const openIds = new Set([...activitySettings.querySelectorAll('.service-settings-card[open]')]
    .map((card) => card.dataset.activityId));
  activitySettings.replaceChildren();
  activitySettingsSection.hidden = installedActivities.length === 0;
  const template = document.getElementById('service-settings-template');
  for (const activity of installedActivities) {
    const preferences = { ...DEFAULT_ACTIVITY_PREFERENCES, ...activity.preferences };
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.activityId = activity.id;
    card.open = openIds.has(activity.id);
    card.querySelector('.service-summary-icon img').src = activity.icon || 'icons/icon32.png';
    card.querySelector('.setting-copy strong').textContent = activity.name;
    card.querySelector('.setting-copy small').textContent = activity.description || activity.matches.join(', ');
    card.classList.toggle('is-disabled', !activity.enabled);

    const master = card.querySelector('.service-master input');
    master.checked = activity.enabled;
    master.dataset.activityEnabled = activity.id;
    master.setAttribute('aria-label', `Enable ${activity.name}`);
    master.addEventListener('click', (event) => event.stopPropagation());

    const labels = {
      paused: 'Show while paused',
      artwork: 'Artwork',
      timestamps: 'Playback progress',
      buttons: 'Action buttons',
    };
    for (const [settingType, preferenceName] of Object.entries({
      paused: 'showPaused',
      artwork: 'showArtwork',
      timestamps: 'showTimestamps',
      buttons: 'showButtons',
    })) {
      const input = card.querySelector(`[data-setting="${settingType}"]`);
      input.checked = preferences[preferenceName];
      input.dataset.activityPreference = preferenceName;
      input.dataset.activityId = activity.id;
      input.setAttribute('aria-label', `${labels[settingType]} for ${activity.name}`);
    }

    const statusSelect = card.querySelector('[data-setting="status"]');
    const statusOptions = activity.id === 'crunchyroll'
      ? [['app', 'Crunchyroll'], ['artist', 'Series'], ['track', 'Episode']]
      : [['app', 'Activity name'], ['artist', 'Artist / creator'], ['track', 'Media title']];
    for (const [value, label] of statusOptions) {
      statusSelect.append(new Option(label, value));
    }
    statusSelect.value = preferences.statusDisplay;
    statusSelect.dataset.activityPreference = 'statusDisplay';
    statusSelect.dataset.activityId = activity.id;
    statusSelect.setAttribute('aria-label', `Status text for ${activity.name}`);
    activitySettings.append(card);
  }
}

function showActivitySettings(id) {
  showView('settings');
  const card = [...activitySettings.querySelectorAll('.service-settings-card')]
    .find((item) => item.dataset.activityId === id);
  if (card) card.open = true;
}

async function refreshInstalledActivities() {
  const state = await activityExtensionMessage({ type: 'ACTIVITY_LIBRARY_STATE' });
  installedActivities = Array.isArray(state?.installed) ? state.installed : [];
  renderInstalledActivityTiles();
  renderInstalledActivitySettings();
  activeServiceIcon.src = sourceIcon(lastState?.track);
}

async function updateActivityPreference(input) {
  const { activityId, activityPreference } = input.dataset;
  const value = input.type === 'checkbox' ? input.checked : input.value;
  try {
    await activityExtensionMessage({
      type: 'ACTIVITY_SET_PREFERENCES',
      id: activityId,
      preferences: { [activityPreference]: value },
    });
    saveStatus.textContent = 'Saved';
    saveStatus.classList.add('saved');
    await refreshInstalledActivities();
    await refresh();
  } catch (error) {
    saveStatus.textContent = error.message || 'Could not save';
    saveStatus.classList.remove('saved');
    await refreshInstalledActivities().catch(() => {});
  }
}

async function updateActivityEnabled(input) {
  const id = input.dataset.activityEnabled;
  input.disabled = true;
  try {
    await activityExtensionMessage({ type: 'ACTIVITY_SET_ENABLED', id, enabled: input.checked });
    await refreshInstalledActivities();
    await refresh();
    saveStatus.textContent = 'Saved';
    saveStatus.classList.add('saved');
  } catch (error) {
    saveStatus.textContent = error.message || 'Could not update Activity';
    saveStatus.classList.remove('saved');
    await refreshInstalledActivities().catch(() => {});
  } finally {
    const current = activitySettings.querySelector(`[data-activity-enabled="${id}"]`);
    if (current) current.disabled = false;
  }
}

function renderForm(settings) {
  const normalized = normalizeSettings(settings);
  for (const [key, value] of Object.entries(normalized)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  updateServiceStates(normalized);
  formHasLoaded = true;
}

function readForm() {
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const input = form.elements.namedItem(key);
    settings[key] = typeof fallback === 'boolean' ? Boolean(input?.checked) : String(input?.value || '').trim();
  }
  return settings;
}

function renderDiscord(delivery = {}) {
  const authenticated = delivery.authenticated === true;
  const buttonText = authenticated ? 'Disconnect' : 'Connect';
  for (const button of [discordAction, settingsDiscordAction]) {
    button.dataset.action = authenticated ? 'disconnect' : 'connect';
    const textNode = button.querySelector('span');
    if (textNode) textNode.textContent = buttonText;
    else button.textContent = buttonText;
  }
  document.getElementById('discord-title').textContent = authenticated ? 'Discord connected' : 'Connect Discord';
  discordStatus.textContent = authenticated ? 'Connected and ready to publish' : 'Not connected';
  document.getElementById('discord-dot').classList.toggle('on', delivery.available === true);
}

function renderDashboard(state) {
  lastState = state;
  const settings = normalizeSettings(state.settings);
  const track = state.track;
  const source = sourceName(track);
  const enabled = settings.enabled !== false;
  const active = enabled && Boolean(track?.title);

  document.body.dataset.enabled = String(enabled);
  document.getElementById('brand-status').textContent = !enabled ? 'Activity paused' : active ? `${source} active` : 'Ready to share';
  document.getElementById('extension-dot').classList.toggle('on', enabled);
  activeServiceIcon.src = sourceIcon(track);
  presenceState.classList.toggle('active', active);
  presenceState.replaceChildren(
    document.createElement('i'),
    document.createTextNode(active ? 'Active' : enabled ? 'Waiting' : 'Paused'),
  );

  if (track?.title) {
    kickerEl.textContent = track.playing ? `Now playing · ${source}` : `Paused · ${source}`;
    titleEl.textContent = track.title;
    artistEl.textContent = [track.artist, track.album].filter(Boolean).join(' • ') || source;
    if (track.artwork) {
      artEl.src = track.artwork;
      artEl.hidden = false;
      artFallback.hidden = true;
    } else {
      artEl.hidden = true;
      artFallback.hidden = false;
    }
  } else {
    kickerEl.textContent = enabled ? 'Nothing playing' : 'Activity sharing paused';
    titleEl.textContent = enabled ? 'Open a supported streaming site' : 'ChudPresence Solo is turned off';
    artistEl.textContent = enabled ? 'Your activity preview will appear here.' : 'Enable it in Settings when you are ready.';
    artEl.removeAttribute('src');
    artEl.hidden = true;
    artFallback.hidden = false;
  }

  titleEl.title = titleEl.textContent;
  artistEl.title = artistEl.textContent;
  hintEl.textContent = state.delivery?.message || (state.delivery?.authenticated ? 'Ready to share activity.' : 'Share what you are watching or listening to.');
  renderDiscord(state.delivery);
  updateServiceStates(settings);
  if (!formHasLoaded) renderForm(settings);
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state) renderDashboard(state);
  } catch {
    hintEl.textContent = 'Reload the extension if this panel stays empty.';
  }
}

async function refreshDiscordSetup() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_DISCORD_SETUP' });
    if (result?.ok && result.setup?.redirectUrl) {
      firefoxOAuthRedirectUrl = result.setup.redirectUrl;
      firefoxOAuthRedirect.textContent = `Firefox callback — click to copy\n${firefoxOAuthRedirectUrl}`;
      firefoxOAuthRedirect.hidden = false;
    }
  } catch {
    // The standard Discord status already advises reloading if the background is unavailable.
  }
}

firefoxOAuthRedirect.addEventListener('click', async () => {
  if (!firefoxOAuthRedirectUrl) return;
  try {
    await navigator.clipboard.writeText(firefoxOAuthRedirectUrl);
    firefoxOAuthRedirect.textContent = 'Firefox callback copied';
    setTimeout(() => {
      firefoxOAuthRedirect.textContent = `Firefox callback — click to copy\n${firefoxOAuthRedirectUrl}`;
    }, 1_500);
  } catch {
    // The URL stays selected and visible, so it can still be copied manually.
  }
});

async function saveSettings() {
  clearTimeout(saveTimer);
  const settings = readForm();
  await chrome.storage.local.set(settings);
  updateServiceStates(settings);
  document.body.dataset.enabled = String(settings.enabled);
  saveStatus.textContent = 'Saved';
  saveStatus.classList.add('saved');
  saveTimer = setTimeout(() => {
    saveStatus.textContent = 'Saved locally';
    saveStatus.classList.remove('saved');
  }, 1400);
}

async function updateDiscord(event) {
  const button = event.currentTarget;
  const otherButton = button === discordAction ? settingsDiscordAction : discordAction;
  button.disabled = true;
  otherButton.disabled = true;
  discordStatus.textContent = button.dataset.action === 'disconnect' ? 'Disconnecting…' : 'Waiting for Discord…';
  try {
    const type = button.dataset.action === 'disconnect' ? 'DISCONNECT_DISCORD' : 'CONNECT_DISCORD';
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) throw new Error(result?.error || 'Could not update the Discord connection.');
    renderDiscord({ ...(result.delivery || {}), authenticated: result.setup?.authenticated });
    await refresh();
  } catch (error) {
    discordStatus.textContent = error.message || 'Could not update the Discord connection.';
    hintEl.textContent = discordStatus.textContent;
  } finally {
    button.disabled = false;
    otherButton.disabled = false;
  }
}

buildServiceSettings();

activityTab.addEventListener('click', () => showView('activity'));
document.getElementById('show-activity').addEventListener('click', () => showView('activity'));
settingsTab.addEventListener('click', () => showView('settings'));
document.getElementById('open-settings').addEventListener('click', () => showView('settings'));
document.getElementById('manage-services').addEventListener('click', () => {
  showView('settings');
  const firstService = activitySettings.querySelector('.service-settings-card') || document.querySelector('.service-settings-card');
  if (firstService) firstService.open = true;
});

form.addEventListener('change', (event) => {
  if (event.target.dataset.activityEnabled) {
    updateActivityEnabled(event.target);
    return;
  }
  if (event.target.dataset.activityPreference) {
    updateActivityPreference(event.target);
    return;
  }
  if (!event.target.name) return;
  saveSettings().catch(() => {
    saveStatus.classList.remove('saved');
    saveStatus.textContent = 'Could not save';
  });
});

document.getElementById('reset').addEventListener('click', () => {
  renderForm(DEFAULT_SETTINGS);
  saveSettings().catch(() => { saveStatus.textContent = 'Could not restore defaults'; });
});

discordAction.addEventListener('click', updateDiscord);
settingsDiscordAction.addEventListener('click', updateDiscord);
artEl.addEventListener('error', () => {
  artEl.hidden = true;
  artFallback.hidden = false;
});

if (location.hash === '#settings') showView('settings');
refresh();
refreshInstalledActivities().catch(() => {});
refreshDiscordSetup();
setInterval(() => {
  if (document.body.dataset.view === 'activity') refresh();
}, 1000);
