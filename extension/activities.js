import { compareActivityVersions, downloadActivity, fetchCatalog, readCatalogCache } from './core/activity-repository.js';
import { requestHostPermissions, requestRepositoryPermission, requestUserScriptsPermission } from './core/activity-permissions.js';
import {
  MAX_ACTIVITY_ICON_BYTES,
  validateActivityIcon,
  validateActivityMetadata,
  validateActivitySource,
  isSupportedActivityApiVersion,
} from './core/activity-validator.js';

const api = globalThis.browser || globalThis.chrome;
const pageStatus = document.getElementById('page-status');
const statusDot = document.getElementById('status-dot');
const catalogNotice = document.getElementById('catalog-notice');
const catalogAge = document.getElementById('catalog-age');
const discoverList = document.getElementById('discover-list');
const installedList = document.getElementById('installed-list');
const updatesList = document.getElementById('updates-list');
const searchInput = document.getElementById('search');
const categoryFilter = document.getElementById('category-filter');
const localFiles = document.getElementById('local-files');
const loadLocalButton = document.getElementById('load-local');
const developerNotice = document.getElementById('developer-notice');
const selectedFiles = document.getElementById('selected-files');
const developerEnabled = document.getElementById('developer-enabled');
const developerPanel = document.getElementById('developer-panel');

let catalog = null;
let installed = [];
let pendingLocalPackage = null;
let userScriptsPermissionGranted = false;
let nextPermissionStep = '';
let libraryDiagnostics = { grantedOrigins: [], finalPresenceIntent: null };

function setHeaderStatus(message, type = '') {
  pageStatus.textContent = message;
  statusDot.className = type;
}

function setNotice(element, message, type = '') {
  element.textContent = message;
  element.className = `notice${type ? ` ${type}` : ''}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function extensionMessage(message) {
  return api.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || 'ChudPresence could not complete that action.');
    return response.result;
  });
}

function installedById() {
  return new Map(installed.map((item) => [item.id, item]));
}

function formatVersion(version) {
  return `v${version}`;
}

function compatibilityMessage(entry) {
  const currentVersion = api.runtime?.getManifest?.().version || '0.0.0';
  if (!isSupportedActivityApiVersion(entry.apiVersion)) return `Requires Activity API v${entry.apiVersion}`;
  if (entry.minExtensionVersion && compareActivityVersions(currentVersion, entry.minExtensionVersion) < 0) {
    return `Requires ChudPresence ${formatVersion(entry.minExtensionVersion)} or newer`;
  }
  return '';
}

function hostSummary(matches = []) {
  return matches.map((pattern) => {
    const match = pattern.match(/^https:\/\/([^/]+)/i);
    if (!match) return pattern;
    return match[1].startsWith('*.') ? `${match[1].slice(2)} and subdomains` : match[1];
  }).join(', ');
}

function refreshCounters() {
  const updateCount = catalog?.activities?.filter((entry) => {
    const record = installedById().get(entry.id);
    return !compatibilityMessage(entry) && record?.source?.type === 'repository' && compareActivityVersions(entry.version, record.version) > 0;
  }).length || 0;
  document.getElementById('installed-count').textContent = String(installed.length);
  document.getElementById('update-count').textContent = String(updateCount);
}

function appendEmpty(target, title, detail) {
  const empty = element('div', 'empty-state');
  empty.append(element('strong', '', title), element('span', '', detail));
  target.append(empty);
}

function actionButton(text, className, action, disabled = false) {
  const button = element('button', `button ${className}`, text);
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

function baseCard({ name, description, category, version, matches, icon = '', local = false }) {
  const card = element('article', 'activity-card');
  const top = element('div', 'card-top');
  const identity = element('div', 'card-identity');
  if (icon) {
    const image = element('img', 'activity-logo');
    image.src = icon;
    image.alt = '';
    image.addEventListener('error', () => image.remove());
    identity.append(image);
  }
  const heading = element('h3', '', name);
  identity.append(heading);
  const badge = element('span', `badge${local ? ' local' : ''}`, local ? 'Local' : category || 'other');
  top.append(identity, badge);
  card.append(top, element('p', 'card-description', description || 'No description provided.'));
  const meta = element('div', 'card-meta');
  meta.append(element('span', '', formatVersion(version || '0.0.0')));
  meta.append(element('span', 'card-sites', hostSummary(matches)));
  card.append(meta);
  return { card, actions: element('div', 'card-actions') };
}

function renderDiscover() {
  discoverList.replaceChildren();
  const entries = catalog?.activities || [];
  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;
  const filtered = entries.filter((entry) => {
    const matchesQuery = !query || [entry.name, entry.description, entry.id, entry.category,
      ...(entry.aliases || []), ...(entry.tags || [])]
      .some((value) => String(value || '').toLowerCase().includes(query));
    return matchesQuery && (category === 'all' || entry.category === category);
  });
  if (!filtered.length) {
    appendEmpty(discoverList, catalog ? 'No matching Activities' : 'Catalog not connected', catalog
      ? 'Try a different search or category.'
      : 'Use Refresh catalog to connect to ChudForks/ChudPresence-Activities.');
    return;
  }

  const installedMap = installedById();
  for (const entry of filtered) {
    const { card, actions } = baseCard(entry);
    const record = installedMap.get(entry.id);
    const compatibility = compatibilityMessage(entry);
    if (compatibility) {
      card.querySelector('.badge').textContent = compatibility;
      card.querySelector('.badge').className = 'badge issue';
      card.querySelector('.card-description').textContent = `${entry.description} ${compatibility}.`;
      actions.append(actionButton('Unavailable', 'secondary', () => {}, true));
    } else if (!record) {
      actions.append(actionButton('Install', 'primary', () => installRepositoryActivity(entry)));
    } else if (record.source?.type === 'repository' && compareActivityVersions(entry.version, record.version) > 0) {
      actions.append(actionButton(`Update to ${formatVersion(entry.version)}`, 'primary', () => installRepositoryActivity(entry)));
    } else {
      actions.append(actionButton('Installed', 'secondary', () => showView('installed'), true));
    }
    card.append(actions);
    discoverList.append(card);
  }
}

function renderActivitySettings(record, card) {
  if (!record.settings?.length) return;
  const group = element('fieldset', 'activity-settings');
  group.append(element('legend', '', 'Activity settings'));
  const status = element('div', 'setting-status');
  for (const setting of record.settings) {
    const row = element('label', 'activity-setting');
    row.append(element('span', '', setting.label));
    let control;
    if (setting.type === 'boolean') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = record.settingValues?.[setting.id] ?? setting.default;
    } else if (setting.type === 'select') {
      control = document.createElement('select');
      for (const option of setting.options || []) {
        const choice = new Option(option.label, option.value);
        control.add(choice);
      }
      control.value = record.settingValues?.[setting.id] ?? setting.default;
    } else {
      control = document.createElement('input');
      control.type = setting.type === 'number' ? 'number' : setting.type;
      if (setting.type === 'number' || setting.type === 'range') {
        control.min = String(setting.min);
        control.max = String(setting.max);
        if (setting.step !== undefined) control.step = String(setting.step);
        const currentValue = record.settingValues?.[setting.id] ?? setting.default;
        control.value = String(currentValue);
        if (setting.type === 'range') {
          const output = element('output', 'setting-output', String(currentValue));
          control.addEventListener('input', () => { output.value = control.value; output.textContent = control.value; });
          row.append(output);
        }
      } else {
        control.type = 'text';
        control.maxLength = setting.maxLength ?? 256;
        control.value = record.settingValues?.[setting.id] ?? setting.default;
      }
    }
    control.setAttribute('aria-label', setting.label);
    control.addEventListener('change', async () => {
      const value = setting.type === 'boolean'
        ? control.checked
        : setting.type === 'number' || setting.type === 'range'
          ? Number(control.value)
          : control.value;
      control.disabled = true;
      status.textContent = '';
      try {
        await extensionMessage({ type: 'ACTIVITY_SET_SETTING', id: record.id, settingId: setting.id, value });
        await refreshInstalled();
      } catch (error) {
        await refreshInstalled();
        setHeaderStatus(error.message || 'Could not save this setting.', 'error');
      }
    });
    row.append(control);
    group.append(row);
  }
  group.append(status);
  card.append(group);
}

function renderInstalled() {
  installedList.replaceChildren();
  if (!installed.length) {
    appendEmpty(installedList, 'No Activities installed', 'Browse Discover or load a local Activity in Developer.');
    return;
  }
  for (const record of installed) {
    const { card, actions } = baseCard({ ...record, local: record.source?.type === 'local' });
    const statusText = {
      detected: 'Site detected',
      waiting: 'Waiting for site',
      disabled: 'Disabled',
      incompatible: record.compatibilityStatus || 'Requires newer ChudPresence',
      'permission-missing': 'Permission missing',
      error: 'Error',
    }[record.status] || 'Waiting for site';
    const badge = card.querySelector('.badge');
    badge.textContent = `${record.source?.type === 'local' ? 'Local · ' : ''}${statusText}`;
    badge.title = record.error || '';
    badge.className = `badge${record.status === 'detected' ? ' active' : ['incompatible', 'permission-missing', 'error'].includes(record.status) ? ' issue' : record.source?.type === 'local' ? ' local' : ''}`;
    if (developerEnabled.checked) {
      const contexts = record.frameContexts || [];
      const requests = record.networkRequests || [];
      const isCurrentIntent = libraryDiagnostics.finalPresenceIntent?.source === record.id;
      const diagnosticLines = [
        `Activity ID: ${record.id}`,
        `Current Activity version: ${record.version}`,
        `Installed repository revision: ${record.source?.revision || 'not recorded'}`,
        `Installed code SHA-256: ${record.source?.codeSha256 || 'not recorded'}`,
        `Installed metadata SHA-256: ${record.source?.metadataSha256 || 'not recorded'}`,
        `Installed icon SHA-256: ${record.source?.iconSha256 || 'not recorded'}`,
        `Frame scope: ${record.frames || 'top'}`,
        ...(contexts.length
          ? contexts.map((frame) => `${frame.state} ${frame.frameId === 0 ? 'top frame' : `frame ${frame.frameId}`} · ${frame.senderUrl} · document ${frame.documentId || 'unknown'}${frame.retiredDocumentIds?.length ? ` · replaced ${frame.retiredDocumentIds.join(', ')}` : ''}`)
          : ['No frame reports yet']),
        `Declared network: ${hostSummary(record.network || []) || 'none'}`,
        `Granted origins: ${hostSummary(libraryDiagnostics.grantedOrigins || []) || 'none'}`,
        `Current settings: ${JSON.stringify(record.settingValues || {})}`,
        `Current raw report:\n${JSON.stringify(record.rawReport, null, 2) || 'none'}`,
        `Normalized report:\n${JSON.stringify(record.normalizedReport, null, 2) || 'none'}`,
        `Final presence intent:\n${JSON.stringify(isCurrentIntent ? libraryDiagnostics.finalPresenceIntent : null, null, 2) || 'none'}`,
        `Last report: ${JSON.stringify(record.lastReport || null)}`,
        `Last clear: ${JSON.stringify(record.lastClear || null)}`,
        `Last error: ${JSON.stringify(record.lastError || null)}`,
        `Pending upgrade: ${JSON.stringify(record.pendingUpgrade || null)}`,
        `Last upgrade: ${JSON.stringify(record.lastUpgrade || null)}`,
        ...requests.map((request) => `${request.method} ${request.url} · tab ${request.tabId} frame ${request.frameId} · ${request.state === 'complete' ? request.status : request.state === 'error' ? request.errorCode : 'pending'} · ${request.durationMs} ms · ${request.responseBytes} bytes`),
        ...(record.activityLogs || []).map((entry) => `${entry.timestamp} ${entry.level.toUpperCase()} · tab ${entry.tabId} frame ${entry.frameId} · ${JSON.stringify(entry.args)}`),
      ];
      const diagnostics = element('div', 'runtime-diagnostics', diagnosticLines.join('\n'));
      card.append(diagnostics);
    }
    renderActivitySettings(record, card);
    if (developerEnabled.checked && record.enabled && !record.compatibilityStatus) {
      actions.append(actionButton('Reload Activity', 'secondary', () => reloadActivity(record)));
    }
    actions.append(actionButton(record.enabled ? 'Disable' : 'Enable', 'secondary', () => toggleActivity(record)));
    actions.append(actionButton('Remove', 'secondary remove', () => removeActivity(record)));
    card.append(actions);
    installedList.append(card);
  }
}

function renderUpdates() {
  updatesList.replaceChildren();
  const entries = catalog?.activities || [];
  const installedMap = installedById();
  const pending = entries.filter((entry) => {
    const record = installedMap.get(entry.id);
    return !compatibilityMessage(entry) && record?.source?.type === 'repository' && compareActivityVersions(entry.version, record.version) > 0;
  });
  if (!pending.length) {
    appendEmpty(updatesList, 'You’re up to date', catalog
      ? 'No updates are available for repository Activities.'
      : 'Refresh the catalog to check for updates.');
    return;
  }
  for (const entry of pending) {
    const record = installedMap.get(entry.id);
    const { card, actions } = baseCard(entry);
    card.querySelector('.card-description').textContent = `${entry.description} Installed ${formatVersion(record.version)} · latest ${formatVersion(entry.version)}.`;
    actions.append(actionButton(`Update to ${formatVersion(entry.version)}`, 'primary', () => installRepositoryActivity(entry)));
    card.append(actions);
    updatesList.append(card);
  }
}

function renderAll() {
  renderDiscover();
  renderInstalled();
  renderUpdates();
  refreshCounters();
}

function renderCategories() {
  const selected = categoryFilter.value;
  const categories = [...new Set((catalog?.activities || []).map((entry) => entry.category).filter(Boolean))].sort();
  categoryFilter.replaceChildren(new Option('All categories', 'all'));
  for (const value of categories) categoryFilter.add(new Option(value.replaceAll('-', ' '), value));
  categoryFilter.value = categories.includes(selected) ? selected : 'all';
}

function showView(view) {
  for (const button of document.querySelectorAll('.tab')) button.classList.toggle('is-active', button.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${view}-view`;
}

function describeCatalog(cached, fetchedAt) {
  if (fetchedAt) {
    const date = new Date(fetchedAt);
    catalogAge.textContent = `${cached ? 'Cached' : 'Updated'} ${date.toLocaleString()}`;
  } else {
    catalogAge.textContent = '';
  }
}

async function refreshInstalled() {
  const state = await extensionMessage({ type: 'ACTIVITY_LIBRARY_STATE' });
  installed = state.installed || [];
  libraryDiagnostics = {
    grantedOrigins: state.grantedOrigins || [],
    finalPresenceIntent: state.finalPresenceIntent || null,
  };
  userScriptsPermissionGranted = state.userScriptsPermission === true;
  setHeaderStatus(
    nextPermissionStep || (state.userScriptsPermission
      ? `${installed.length} installed · isolated runtime ready`
      : 'Grant userScripts permission when installing'),
    state.userScriptsPermission ? 'on' : '',
  );
  renderAll();
}

async function refreshCatalog() {
  const button = document.getElementById('refresh-catalog');
  button.disabled = true;
  try {
    setNotice(catalogNotice, 'Requesting access to the ChudPresence Activities catalog…');
    const granted = await requestRepositoryPermission(api);
    if (!granted) throw new Error('Catalog access was not granted. You can keep using cached or local Activities.');
    const result = await fetchCatalog({ force: true });
    catalog = result.catalog;
    describeCatalog(false, result.fetchedAt);
    renderCategories();
    setNotice(catalogNotice, `Loaded ${catalog.activities.length} Activities from ChudForks/ChudPresence-Activities.`, 'success');
    await refreshInstalled();
  } catch (error) {
    const cached = await readCatalogCache().catch(() => ({ catalog: null, fetchedAt: 0 }));
    catalog = cached.catalog;
    describeCatalog(Boolean(catalog), cached.fetchedAt);
    renderCategories();
    if (catalog) {
      setNotice(catalogNotice, `Could not refresh the repository. Showing the cached catalog. ${error.message}`, 'error');
    } else {
      setNotice(catalogNotice, `${error.message} Local Activity loading remains available in Developer.`, 'error');
    }
    renderAll();
  } finally {
    button.disabled = false;
  }
}

async function ensureActivityPermissions(matches, noticeElement = catalogNotice) {
  if (!userScriptsPermissionGranted) {
    // Firefox requires this optional permission to be requested alone. Its prompt
    // consumes the click activation, so request declared origins on the user's next click.
    const scriptsAllowed = await requestUserScriptsPermission(api);
    if (!scriptsAllowed) throw new Error('The userScripts permission is required to run Activities.');
    userScriptsPermissionGranted = true;
    nextPermissionStep = 'Click the Activity action again to grant declared site and network access.';
    setHeaderStatus(nextPermissionStep, 'on');
    if (noticeElement) {
      setNotice(noticeElement, 'Click this action again to request the Activity’s declared website and network access.', 'success');
    }
    return false;
  }
  nextPermissionStep = '';
  const hostsAllowed = await requestHostPermissions(matches, api);
  if (!hostsAllowed) throw new Error('The Activity’s declared site or network access was not granted. It was not installed.');
  return true;
}

async function installPackage(activityPackage) {
  if (!await ensureActivityPermissions(
    [...activityPackage.metadata.matches, ...(activityPackage.metadata.network || [])],
    developerNotice,
  )) return null;
  const result = await extensionMessage({ type: 'ACTIVITY_INSTALL', activityPackage });
  await refreshInstalled();
  return result;
}

async function installRepositoryActivity(entry) {
  try {
    const compatibility = compatibilityMessage(entry);
    if (compatibility) throw new Error(compatibility);
    // Firefox permission prompts require the user activation from this click.
    // Downloading first can consume it before permissions.request() runs.
    if (!await ensureActivityPermissions([
      ...entry.matches,
      ...(entry.network || []),
    ])) return;
    setHeaderStatus(`Downloading ${entry.name}…`);
    const activityPackage = await downloadActivity(entry.id, catalog);
    const result = await extensionMessage({
      type: 'ACTIVITY_INSTALL',
      activityPackage: { ...activityPackage, sourceType: 'repository' },
    });
    setNotice(catalogNotice, `${result.name} ${formatVersion(result.version)} installed.`, 'success');
    await refreshInstalled();
    showView('installed');
  } catch (error) {
    setNotice(catalogNotice, error.message, 'error');
    setHeaderStatus('Activity installation failed', 'error');
  }
}

async function toggleActivity(record) {
  try {
    if (!record.enabled && !await ensureActivityPermissions([
      ...record.matches,
      ...(record.network || []),
    ], null)) return;
    await extensionMessage({ type: 'ACTIVITY_SET_ENABLED', id: record.id, enabled: !record.enabled });
    await refreshInstalled();
  } catch (error) {
    setHeaderStatus(error.message, 'error');
  }
}

async function removeActivity(record) {
  try {
    await extensionMessage({ type: 'ACTIVITY_REMOVE', id: record.id });
    await refreshInstalled();
  } catch (error) {
    setHeaderStatus(error.message, 'error');
  }
}

async function reloadActivity(record) {
  try {
    const result = await extensionMessage({ type: 'ACTIVITY_RELOAD', id: record.id });
    await refreshInstalled();
    setHeaderStatus(`${record.name} reloaded in ${result.reloadedFrames} active frame${result.reloadedFrames === 1 ? '' : 's'}.`, 'on');
  } catch (error) {
    setHeaderStatus(error.message || 'Could not reload this Activity.', 'error');
  }
}

function filesForLocalPackage() {
  const files = [...(localFiles.files || [])];
  return {
    metadataFile: files.find((file) => file.name === 'metadata.json'),
    sourceFile: files.find((file) => file.name === 'activity.js'),
    iconFile: files.find((file) => file.name === 'icon.png'),
  };
}

async function readActivityIcon(file) {
  if (!file) return '';
  if (file.size > MAX_ACTIVITY_ICON_BYTES) throw new Error('Activity icon exceeds the 256 KB size limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return validateActivityIcon(`data:image/png;base64,${btoa(binary)}`);
}

async function updateSelectedFiles() {
  const { metadataFile, sourceFile, iconFile } = filesForLocalPackage();
  pendingLocalPackage = null;
  loadLocalButton.disabled = true;
  if (!metadataFile || !sourceFile) {
    selectedFiles.textContent = 'Choose metadata.json and activity.js together.';
    return;
  }
  try {
    const [metadataText, source, icon] = await Promise.all([
      metadataFile.text(), sourceFile.text(), readActivityIcon(iconFile),
    ]);
    const metadata = validateActivityMetadata(JSON.parse(metadataText));
    validateActivitySource(source);
    if (Boolean(metadata.icon) !== Boolean(icon)) {
      throw new Error('Choose icon.png when metadata.json declares an icon, and include the metadata field when using an icon.');
    }
    pendingLocalPackage = { metadata, source, ...(icon ? { icon: `data:image/png;base64,${icon}` } : {}), sourceType: 'local' };
    selectedFiles.textContent = `${metadata.name} ${formatVersion(metadata.version)} ready to load.`;
    loadLocalButton.disabled = false;
  } catch (error) {
    selectedFiles.textContent = error.message || 'Those files are not a valid Activity package.';
  }
}

async function loadLocalActivity() {
  loadLocalButton.disabled = true;
  try {
    if (!pendingLocalPackage) throw new Error('Select and validate metadata.json and activity.js first.');
    const { metadata } = pendingLocalPackage;
    if (!await installPackage(pendingLocalPackage)) return;
    setNotice(developerNotice, `${metadata.name} ${formatVersion(metadata.version)} loaded locally.`, 'success');
    showView('installed');
  } catch (error) {
    setNotice(developerNotice, error.message || 'Could not load this Activity.', 'error');
  } finally {
    loadLocalButton.disabled = !pendingLocalPackage;
  }
}

async function initialize() {
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => showView(button.dataset.view));
  }
  document.getElementById('refresh-catalog').addEventListener('click', refreshCatalog);
  searchInput.addEventListener('input', renderDiscover);
  categoryFilter.addEventListener('change', renderDiscover);
  localFiles.addEventListener('change', updateSelectedFiles);
  loadLocalButton.addEventListener('click', loadLocalActivity);
  developerEnabled.addEventListener('change', async () => {
    developerPanel.hidden = !developerEnabled.checked;
    await api.storage.local.set({ developerMode: developerEnabled.checked });
  });

  const [cache, localSettings] = await Promise.all([
    readCatalogCache().catch(() => ({ catalog: null, fetchedAt: 0 })),
    api.storage.local.get('developerMode').catch(() => ({})),
  ]);
  catalog = cache.catalog;
  describeCatalog(Boolean(catalog), cache.fetchedAt);
  developerEnabled.checked = localSettings.developerMode === true;
  developerPanel.hidden = !developerEnabled.checked;
  renderCategories();
  await refreshInstalled().catch((error) => setHeaderStatus(error.message, 'error'));
  setInterval(() => {
    if (!document.hidden) refreshInstalled().catch(() => {});
  }, 3000);
  renderAll();
  if (catalog) {
    setNotice(catalogNotice, 'Showing the cached catalog. Refresh to check for new Activities.', '');
  } else {
    setNotice(catalogNotice, 'Connect to the ChudForks/ChudPresence-Activities catalog, or load an Activity locally in Developer.');
  }
  const requestedView = new URL(location.href).searchParams.get('view');
  if (['discover', 'installed', 'updates', 'developer'].includes(requestedView)) showView(requestedView);
}

initialize().catch((error) => setHeaderStatus(error.message || 'Activity Library could not start.', 'error'));
