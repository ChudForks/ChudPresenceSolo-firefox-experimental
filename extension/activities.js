import { compareActivityVersions, downloadActivity, fetchCatalog, readCatalogCache } from './core/activity-repository.js';
import { requestHostPermissions, requestRepositoryPermission, requestUserScriptsPermission } from './core/activity-permissions.js';
import {
  MAX_ACTIVITY_ICON_BYTES,
  validateActivityIcon,
  validateActivityMetadata,
  validateActivitySource,
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
    return record?.source?.type === 'repository' && compareActivityVersions(entry.version, record.version) > 0;
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
    const matchesQuery = !query || [entry.name, entry.description, entry.id, entry.category]
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
    if (!record) {
      actions.append(actionButton('Install', 'primary', () => installRepositoryActivity(entry)));
    } else if (compareActivityVersions(entry.version, record.version) > 0) {
      actions.append(actionButton(`Update to ${formatVersion(entry.version)}`, 'primary', () => installRepositoryActivity(entry)));
    } else {
      actions.append(actionButton('Installed', 'secondary', () => showView('installed'), true));
    }
    card.append(actions);
    discoverList.append(card);
  }
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
      'permission-missing': 'Permission missing',
      error: 'Error',
    }[record.status] || 'Waiting for site';
    const badge = card.querySelector('.badge');
    badge.textContent = `${record.source?.type === 'local' ? 'Local · ' : ''}${statusText}`;
    badge.title = record.error || '';
    badge.className = `badge${record.status === 'detected' ? ' active' : ['permission-missing', 'error'].includes(record.status) ? ' issue' : record.source?.type === 'local' ? ' local' : ''}`;
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
    return record?.source?.type === 'repository' && compareActivityVersions(entry.version, record.version) > 0;
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
    // consumes the click activation, so request site origins on the user's next click.
    const scriptsAllowed = await requestUserScriptsPermission(api);
    if (!scriptsAllowed) throw new Error('The userScripts permission is required to run Activities.');
    userScriptsPermissionGranted = true;
    nextPermissionStep = 'Click the Activity action again to grant site access and finish.';
    setHeaderStatus(nextPermissionStep, 'on');
    if (noticeElement) {
      setNotice(noticeElement, 'Click this action again to request the Activity’s website access and finish installation.', 'success');
    }
    return false;
  }
  nextPermissionStep = '';
  const hostsAllowed = await requestHostPermissions(matches, api);
  if (!hostsAllowed) throw new Error('Website access was not granted. The Activity was not installed.');
  return true;
}

async function installPackage(activityPackage) {
  if (!await ensureActivityPermissions(
    activityPackage.metadata.matches,
    developerNotice,
  )) return null;
  const result = await extensionMessage({ type: 'ACTIVITY_INSTALL', activityPackage });
  await refreshInstalled();
  return result;
}

async function installRepositoryActivity(entry) {
  try {
    if (!await ensureActivityPermissions(entry.matches)) return;
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
    if (!record.enabled && !await ensureActivityPermissions(record.matches, null)) return;
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
