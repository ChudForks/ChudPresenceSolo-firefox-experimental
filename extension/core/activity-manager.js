import {
  hasHostPermissions,
  hasUserScriptsPermission,
} from './activity-permissions.js';
import {
  ACTIVITY_API_VERSION,
  isActivityId,
  normalizeActivityReport,
  validateActivityIcon,
  validateActivityMetadata,
  validateActivitySource,
} from './activity-validator.js';
import {
  mergeActivityPreferences,
  normalizeActivityPreferences,
} from './activity-settings.js';

const STORAGE_KEY = 'installedActivities';
const SCRIPT_ID_PREFIX = 'chudpresence-activity-';
const WORLD_ID_PREFIX = 'chudpresence.activity.';
const MAX_REPORTS_PER_WINDOW = 30;
const REPORT_WINDOW_MS = 10_000;
const STATUS_TTL_MS = 30_000;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

function activityScriptId(id) {
  return `${SCRIPT_ID_PREFIX}${id}`;
}

function activityWorldId(id) {
  return `${WORLD_ID_PREFIX}${id}`;
}

function scriptDefinition(record) {
  const id = record.metadata.id;
  const code = [
    '(() => {',
    "  'use strict';",
    '  const ChudPresence = Object.freeze({',
    '    report(report) { return browser.runtime.sendMessage({ type: "CHUDPRESENCE_ACTIVITY_REPORT", report }); },',
    '    clear() { return browser.runtime.sendMessage({ type: "CHUDPRESENCE_ACTIVITY_CLEAR" }); },',
    '  });',
    '  (() => {',
    record.code,
    '  })();',
    '})();',
  ].join('\n');
  return {
    id: activityScriptId(id),
    worldId: activityWorldId(id),
    world: 'USER_SCRIPT',
    matches: [...record.metadata.matches],
    runAt: 'document_idle',
    js: [{ code }],
  };
}

function safeMatch(pattern, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const match = pattern.match(/^(https):\/\/([^/]+)\/(.*)$/i);
  if (!match || url.protocol !== `${match[1].toLowerCase()}:`) return false;
  const hostPattern = match[2].toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const hostMatches = hostPattern.startsWith('*.')
    ? hostname === hostPattern.slice(2) || hostname.endsWith(`.${hostPattern.slice(2)}`)
    : hostname === hostPattern;
  if (!hostMatches) return false;
  const pathPattern = `/${match[3]}`;
  const escaped = pathPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(`${url.pathname}${url.search}`);
}

export class ActivityManager {
  constructor({ api = extensionApi(), onReport = () => {}, onClear = () => {} } = {}) {
    if (!api?.storage?.local) throw new Error('Extension storage API is required.');
    this.api = api;
    this.onReport = onReport;
    this.onClear = onClear;
    this.records = null;
    this.lastSeen = new Map();
    this.reportRates = new Map();
    this.operation = Promise.resolve();
  }

  serialize(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(() => {});
    return result;
  }

  async load() {
    if (this.records) return this.records;
    const result = await this.api.storage.local.get(STORAGE_KEY);
    const value = result?.[STORAGE_KEY];
    this.records = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return this.records;
  }

  async save() {
    await this.api.storage.local.set({ [STORAGE_KEY]: this.records || {} });
  }

  async listInstalled() {
    const records = await this.load();
    const now = Date.now();
    return Object.values(records).filter((record) =>
      record && typeof record === 'object' && record.metadata &&
      isActivityId(record.metadata.id) && typeof record.metadata.name === 'string',
    ).map((record) => {
      const seenEntries = [...(this.lastSeen.get(record.metadata.id)?.values() || [])]
        .filter((seen) => now - seen.lastSeen < STATUS_TTL_MS)
        .sort((a, b) => b.lastSeen - a.lastSeen);
      const seen = seenEntries[0];
      const detected = Boolean(seen);
      return {
        id: record.metadata.id,
        name: record.metadata.name,
        description: record.metadata.description,
        version: record.metadata.version,
        apiVersion: record.metadata.apiVersion,
        matches: Array.isArray(record.metadata.matches) ? [...record.metadata.matches] : [],
        category: record.metadata.category || 'other',
        enabled: record.enabled === true,
        source: record.source && typeof record.source === 'object'
          ? { ...record.source }
          : { type: 'local' },
        preferences: normalizeActivityPreferences(record.preferences),
        icon: record.icon ? `data:image/png;base64,${record.icon}` : '',
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        status: !record.enabled
          ? 'disabled'
          : record.permissionMissing
            ? 'permission-missing'
            : detected
              ? 'detected'
              : record.error
                ? 'error'
                : 'waiting',
        error: record.error ? String(record.error).slice(0, 240) : '',
        lastSeen: detected ? seen.lastSeen : 0,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    return (await this.load())[id] || null;
  }

  preferencesFor(id) {
    return normalizeActivityPreferences(this.records?.[id]?.preferences);
  }

  async installedScripts() {
    if (!this.api.userScripts) return [];
    return this.api.userScripts.getScripts();
  }

  async register(record) {
    validateActivityMetadata(record?.metadata);
    validateActivitySource(record?.code);
    if (record.metadata.apiVersion !== ACTIVITY_API_VERSION) {
      throw new Error(`Activity API version ${record.metadata.apiVersion} is not supported.`);
    }
    if (!await hasUserScriptsPermission(this.api)) {
      throw new Error('Grant the userScripts permission before installing an Activity.');
    }
    if (!this.api.userScripts) throw new Error('Firefox userScripts API is unavailable.');
    if (!await hasHostPermissions(record.metadata.matches, this.api)) {
      throw new Error('Grant every website permission requested by this Activity first.');
    }

    const definition = scriptDefinition(record);
    await this.api.userScripts.configureWorld({
      worldId: definition.worldId,
      messaging: true,
    });
    const registered = await this.installedScripts();
    if (registered.some((script) => script.id === definition.id)) {
      await this.api.userScripts.update([definition]);
    } else {
      await this.api.userScripts.register([definition]);
    }
  }

  install(activityPackage) {
    return this.serialize(() => this.installInternal(activityPackage));
  }

  async installInternal(activityPackage) {
    const metadata = validateActivityMetadata(activityPackage?.metadata);
    if (metadata.apiVersion !== ACTIVITY_API_VERSION) throw new Error('This Activity requires an unsupported API version.');
    const code = validateActivitySource(activityPackage?.source);
    const icon = validateActivityIcon(activityPackage?.icon);
    if (Boolean(metadata.icon) !== Boolean(icon)) {
      throw new Error('Activity icon metadata and package icon must be supplied together.');
    }
    const sourceType = activityPackage?.sourceType === 'repository' ? 'repository' : 'local';
    const records = await this.load();
    const previous = records[metadata.id];
    const now = Date.now();
    const record = {
      metadata,
      code,
      enabled: true,
      installedAt: previous?.installedAt || now,
      updatedAt: now,
      source: { type: sourceType },
      preferences: normalizeActivityPreferences(previous?.preferences),
      ...(icon ? { icon } : {}),
    };

    await this.register(record);
    records[metadata.id] = record;
    try {
      await this.save();
    } catch (error) {
      if (previous) await this.register(previous).catch(() => {});
      else await this.unregister(metadata.id).catch(() => {});
      if (previous) records[metadata.id] = previous;
      else delete records[metadata.id];
      throw error;
    }
    return { id: metadata.id, name: metadata.name, version: metadata.version };
  }

  async unregister(id) {
    const scriptId = activityScriptId(id);
    const scripts = await this.installedScripts();
    if (scripts.some((script) => script.id === scriptId)) {
      await this.api.userScripts.unregister({ ids: [scriptId] });
    }
  }

  remove(id) {
    return this.serialize(() => this.removeInternal(id));
  }

  async removeInternal(id) {
    const records = await this.load();
    if (!records[id]) return false;
    const previous = records[id];
    await this.unregister(id);
    delete records[id];
    this.lastSeen.delete(id);
    await this.onClear(id);
    try {
      await this.save();
    } catch (error) {
      records[id] = previous;
      if (previous.enabled) await this.register(previous).catch(() => {});
      throw error;
    }
    return true;
  }

  setEnabled(id, enabled) {
    return this.serialize(() => this.setEnabledInternal(id, enabled));
  }

  setPreferences(id, patch) {
    return this.serialize(() => this.setPreferencesInternal(id, patch));
  }

  async setPreferencesInternal(id, patch) {
    const records = await this.load();
    const record = records[id];
    if (!record) throw new Error(`Activity ${id} is not installed.`);
    const previous = record.preferences;
    record.preferences = mergeActivityPreferences(previous, patch);
    record.updatedAt = Date.now();
    try {
      await this.save();
    } catch (error) {
      if (previous === undefined) delete record.preferences;
      else record.preferences = previous;
      throw error;
    }
    return { id, preferences: normalizeActivityPreferences(record.preferences) };
  }

  async setEnabledInternal(id, enabled) {
    const records = await this.load();
    const record = records[id];
    if (!record) throw new Error(`Activity ${id} is not installed.`);
    const wasEnabled = record.enabled === true;
    const wasPermissionMissing = record.permissionMissing;
    if (enabled) {
      await this.register(record);
      record.permissionMissing = false;
    } else {
      await this.unregister(id);
      record.enabled = false;
      this.lastSeen.delete(id);
      await this.onClear(id);
    }
    record.enabled = Boolean(enabled);
    record.updatedAt = Date.now();
    try {
      await this.save();
    } catch (error) {
      record.enabled = wasEnabled;
      if (wasPermissionMissing === undefined) delete record.permissionMissing;
      else record.permissionMissing = wasPermissionMissing;
      if (enabled && !wasEnabled) await this.unregister(id).catch(() => {});
      else if (!enabled && wasEnabled) await this.register(record).catch(() => {});
      throw error;
    }
    return { id, enabled: record.enabled };
  }

  restoreAll() {
    return this.serialize(() => this.restoreAllInternal());
  }

  async restoreAllInternal() {
    const records = await this.load();
    let registered;
    try {
      if (!await hasUserScriptsPermission(this.api)) {
        for (const [key, record] of Object.entries(records)) {
          if (!record || typeof record !== 'object' || !record.metadata || !isActivityId(record.metadata.id)) {
            delete records[key];
            continue;
          }
          record.permissionMissing = true;
          await this.unregister(record.metadata.id).catch(() => {});
          this.lastSeen.delete(record.metadata.id);
          await this.onClear(record.metadata.id);
        }
        await this.save();
        return { restored: 0, permissionMissing: true };
      }
      registered = await this.installedScripts();
    } catch (error) {
      return { restored: 0, error: error.message };
    }
    let restored = 0;
    for (const [key, record] of Object.entries(records)) {
      if (!record || typeof record !== 'object' || !record.metadata ||
          !isActivityId(record.metadata.id) || record.metadata.id !== key || typeof record.code !== 'string') {
        delete records[key];
        if (isActivityId(key)) {
          await this.unregister(key).catch(() => {});
          await this.onClear(key);
        }
        continue;
      }
      if (record.metadata?.apiVersion !== ACTIVITY_API_VERSION) {
        record.error = `Activity API version ${record.metadata.apiVersion} is not supported.`;
        await this.unregister(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      try {
        record.metadata = validateActivityMetadata(record.metadata);
        validateActivitySource(record.code);
      } catch (error) {
        record.error = String(error.message || 'Stored Activity package is invalid').slice(0, 240);
        await this.unregister(record.metadata.id).catch(() => {});
        await this.onClear(record.metadata.id);
        continue;
      }
      if (!record.enabled) {
        await this.unregister(record.metadata.id).catch(() => {});
        this.lastSeen.delete(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      if (!await hasHostPermissions(record.metadata.matches, this.api)) {
        record.permissionMissing = true;
        await this.unregister(record.metadata.id).catch(() => {});
        this.lastSeen.delete(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      record.permissionMissing = false;
      try {
        const exists = registered.some((script) => script.id === activityScriptId(record.metadata.id));
        const definition = scriptDefinition(record);
        await this.api.userScripts.configureWorld({ worldId: definition.worldId, messaging: true });
        if (exists) await this.api.userScripts.update([definition]);
        else await this.api.userScripts.register([definition]);
        delete record.error;
        restored += 1;
      } catch (error) {
        record.permissionMissing = /permission|denied|not allowed/i.test(error.message || '');
        record.error = String(error.message || 'Activity restore failed').slice(0, 240);
      }
    }
    await this.save();

    const expected = new Set(Object.keys(records).map(activityScriptId));
    const stale = registered
      .filter((script) => script.id?.startsWith(SCRIPT_ID_PREFIX) && !expected.has(script.id))
      .map((script) => script.id);
    if (stale.length) await this.api.userScripts.unregister({ ids: stale }).catch(() => {});
    return { restored, permissionMissing: false };
  }

  allowReport(id, tabId, now = Date.now()) {
    const key = `${id}:${tabId}`;
    const rate = this.reportRates.get(key) || { startedAt: now, count: 0 };
    if (now - rate.startedAt >= REPORT_WINDOW_MS) {
      rate.startedAt = now;
      rate.count = 0;
    }
    rate.count += 1;
    this.reportRates.set(key, rate);
    return rate.count <= MAX_REPORTS_PER_WINDOW;
  }

  async handleUserScriptMessage(message, sender) {
    const records = await this.load();
    const worldId = sender?.userScriptWorldId;
    if (typeof worldId !== 'string' || !worldId.startsWith(WORLD_ID_PREFIX)) return false;
    const id = worldId.slice(WORLD_ID_PREFIX.length);
    const record = records[id];
    const tabId = sender?.tab?.id;
    if (!record || record.metadata.id !== id || !record.enabled || typeof tabId !== 'number') return false;
    if (!record.metadata.matches.some((pattern) => safeMatch(pattern, sender.url || ''))) return false;
    if (!this.allowReport(id, tabId)) return false;

    if (message?.type === 'CHUDPRESENCE_ACTIVITY_CLEAR') {
      const seenTabs = this.lastSeen.get(id);
      const seen = seenTabs?.get(tabId);
      const messageDocumentId = sender.documentId || null;
      const isLateClear = seen && (
        (seen.documentId && messageDocumentId && seen.documentId !== messageDocumentId) ||
        (seen.senderUrl && sender.url && seen.senderUrl !== sender.url)
      );
      if (isLateClear) return true;
      seenTabs?.delete(tabId);
      if (seenTabs?.size === 0) this.lastSeen.delete(id);
      await this.onClear(id, tabId, messageDocumentId);
      return true;
    }
    if (message?.type !== 'CHUDPRESENCE_ACTIVITY_REPORT') return false;

    let report;
    try {
      report = normalizeActivityReport(message.report);
    } catch {
      return false;
    }
    if (!this.lastSeen.has(id)) this.lastSeen.set(id, new Map());
    this.lastSeen.get(id).set(tabId, {
      tabId,
      documentId: sender.documentId || null,
      senderUrl: sender.url || '',
      lastSeen: Date.now(),
    });
    await this.onReport({
      activityId: id,
      documentId: sender.documentId || null,
      tabId,
      track: {
        ...report,
        source: id,
        activityId: id,
        activityName: record.metadata.name,
        activityCategory: record.metadata.category || 'other',
        activityVersion: record.metadata.version,
        idle: false,
        ad: false,
      },
    });
    return true;
  }

  async pruneStale(now = Date.now()) {
    let cleared = 0;
    for (const [id, tabs] of this.lastSeen) {
      for (const [tabId, seen] of tabs) {
        if (now - seen.lastSeen <= STATUS_TTL_MS) continue;
        tabs.delete(tabId);
        await this.onClear(id, tabId, seen.documentId);
        cleared += 1;
      }
      if (!tabs.size) this.lastSeen.delete(id);
    }
    for (const [key, rate] of this.reportRates) {
      if (now - rate.startedAt > REPORT_WINDOW_MS * 2) this.reportRates.delete(key);
    }
    return cleared;
  }

  async status() {
    const records = await this.load();
    const userScriptsPermission = await hasUserScriptsPermission(this.api);
    const statuses = await this.listInstalled();
    return {
      apiVersion: ACTIVITY_API_VERSION,
      userScriptsAvailable: Boolean(this.api.userScripts),
      userScriptsPermission,
      installed: statuses,
      count: Object.keys(records).length,
    };
  }
}
