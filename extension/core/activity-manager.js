import {
  hasHostPermissions,
  hasUserScriptsPermission,
} from './activity-permissions.js';
import {
  LATEST_ACTIVITY_API_VERSION,
  isSupportedActivityApiVersion,
  isActivityId,
  normalizeActivityReport,
  validateActivityIcon,
  validateActivityMetadata,
  validateActivitySource,
} from './activity-validator.js';
import {
  mergeActivitySetting,
  mergeActivityPreferences,
  normalizeActivitySettings,
  normalizeActivityPreferences,
} from './activity-settings.js';
import { compareActivityVersions } from './activity-repository.js';

const STORAGE_KEY = 'installedActivities';
const SCRIPT_ID_PREFIX = 'chudpresence-activity-';
const WORLD_ID_PREFIX = 'chudpresence.activity.';
const MAX_REPORTS_PER_WINDOW = 30;
const REPORT_WINDOW_MS = 10_000;
const STATUS_TTL_MS = 30_000;
const MAX_PAGE_EXECUTE_SOURCE_LENGTH = 16_384;
const MAX_PAGE_EXECUTE_ARGUMENTS_LENGTH = 16_384;
const MAX_PAGE_EXECUTE_RESULT_LENGTH = 65_536;
const MAX_RETIRED_DOCUMENTS_PER_FRAME = 32;
const MAX_NETWORK_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_NETWORK_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_NETWORK_TIMEOUT_MS = 10_000;
const MIN_NETWORK_TIMEOUT_MS = 100;
const MAX_NETWORK_TIMEOUT_MS = 15_000;
const MAX_NETWORK_GLOBAL_CONCURRENCY = 4;
const MAX_NETWORK_ACTIVITY_CONCURRENCY = 2;
const MAX_NETWORK_DIAGNOSTICS = 200;
const PROTECTED_NETWORK_DOMAINS = ['discord.com', 'discordapp.com', 'discordapp.net'];
const ACTIVITY_STORAGE_PREFIX = 'chudpresence.activityStorage:';
const MAX_ACTIVITY_STORAGE_BYTES = 64 * 1024;
const MAX_ACTIVITY_STORAGE_KEY_LENGTH = 128;
const MAX_ACTIVITY_LOGS = 200;
const MAX_ACTIVITY_LOG_ENTRY_BYTES = 4096;
const SECRET_FIELD = /token|secret|cookie|authorization|oauth|credential|password/i;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

function activityScriptId(id) {
  return `${SCRIPT_ID_PREFIX}${id}`;
}

function activityWorldId(id) {
  return `${WORLD_ID_PREFIX}${id}`;
}

function isProtectedPage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol !== 'https:' || PROTECTED_NETWORK_DOMAINS.some((domain) =>
      host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return true;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeDiagnosticUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return 'invalid-url';
  }
}

export function sanitizeDiagnosticValue(value, key = '', depth = 0) {
  if (SECRET_FIELD.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    let sanitized = value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\bmfa\.[A-Za-z0-9_-]{20,}/gi, '[redacted Discord token]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted token]')
      .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|cookie)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1$2[redacted]')
      .replace(/([?&](?:access_token|refresh_token|id_token|token|client_secret|code)=)[^&#\s]*/gi, '$1[redacted]');
    if (/^(?:https?):\/\//i.test(sanitized)) {
      sanitized = safeDiagnosticUrl(sanitized);
    }
    return sanitized.slice(0, 512);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || depth >= 6) return String(value).slice(0, 128);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeDiagnosticValue(entry, key, depth + 1));
  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 64)) {
    sanitized[childKey.slice(0, 80)] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
  }
  return sanitized;
}

async function readLimitedResponse(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > MAX_NETWORK_RESPONSE_BYTES) {
      const error = new RangeError('Network response exceeds the 1 MB limit.');
      error.code = 'response_too_large';
      throw error;
    }
    return { text, byteLength };
  }
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_NETWORK_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      const error = new RangeError('Network response exceeds the 1 MB limit.');
      error.code = 'response_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), byteLength };
}

function pageExecutionCode(source, argsJson) {
  return [
    '(() => {',
    '  try {',
    `    const __args = JSON.parse(${JSON.stringify(argsJson)});`,
    `    const __fn = (${source});`,
    '    if (typeof __fn !== "function") throw new TypeError("page.execute expects a function");',
    '    const __value = Reflect.apply(__fn, undefined, __args);',
    '    if (__value && (typeof __value === "object" || typeof __value === "function") && typeof __value.then === "function") throw new TypeError("page.execute callbacks must return synchronously");',
    '    const __serialized = JSON.stringify(__value);',
    '    if (typeof __serialized !== "string") throw new TypeError("page.execute returned a value that is not JSON-compatible");',
    `    if (__serialized.length > ${MAX_PAGE_EXECUTE_RESULT_LENGTH}) throw new RangeError("page.execute result is too large");`,
    '    return JSON.stringify({ ok: true, value: JSON.parse(__serialized) });',
    '  } catch (__error) {',
    '    let __name = "Error";',
    '    let __message = "Page execution failed";',
    '    try { if (typeof __error?.name === "string") __name = __error.name.slice(0, 80); } catch {}',
    '    try { if (typeof __error?.message === "string") __message = __error.message.slice(0, 500); else __message = String(__error).slice(0, 500); } catch {}',
    '    return JSON.stringify({ ok: false, error: { code: "page_execution_error", name: __name, message: __message } });',
    '  }',
    '})()',
  ].join('\n');
}

function scriptDefinition(record, extensionVersion = '0.0.0') {
  const id = record.metadata.id;
  const code = [
    '(() => {',
    "  'use strict';",
    '  const __activityIdentity = Object.freeze(' + JSON.stringify({
      activityId: id,
      activityVersion: record.metadata.version,
      apiVersion: record.metadata.apiVersion,
      extensionVersion,
    }) + ');',
    '  const __request = (operation, payload = {}) => browser.runtime.sendMessage({',
    '    type: "CHUDPRESENCE_ACTIVITY_REQUEST",',
    '    apiVersion: __activityIdentity.apiVersion,',
    '    requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,',
    '    operation,',
    '    payload,',
    '  });',
    '  let __runtimePort = null;',
    '  const __lifecycleController = new AbortController();',
    '  const __lifecycleTimers = new Map();',
    '  const __lifecycleCleanups = new Set();',
    '  let __lifecycleEnded = false;',
    '  const __runCleanup = (callback) => { try { callback(); } catch {} };',
    '  const __endLifecycle = (reason = "activity-ended") => {',
    '    if (__lifecycleEnded) return false;',
    '    __lifecycleEnded = true;',
    '    __lifecycleController.abort(reason);',
    '    for (const [timer, type] of __lifecycleTimers) {',
    '      if (type === "interval") window.clearInterval(timer); else window.clearTimeout(timer);',
    '    }',
    '    __lifecycleTimers.clear();',
    '    for (const callback of __lifecycleCleanups) __runCleanup(callback);',
    '    __lifecycleCleanups.clear();',
    '    window.removeEventListener("pagehide", __onDocumentEnd);',
    '    window.removeEventListener("beforeunload", __onDocumentEnd);',
    '    try { __runtimePort?.disconnect?.(); } catch {}',
    '    return true;',
    '  };',
    '  const __onDocumentEnd = () => __endLifecycle("document-destroyed");',
    '  const __matchesActivity = (message) => message?.type === "CHUDPRESENCE_ACTIVITY_ABORT" &&',
    '    message.activityId === __activityIdentity.activityId && message.activityVersion === __activityIdentity.activityVersion;',
    '  window.addEventListener("pagehide", __onDocumentEnd, { once: true });',
    '  window.addEventListener("beforeunload", __onDocumentEnd, { once: true });',
    '  const __upgradeListeners = new Set();',
    '  const __lifecycle = Object.freeze({',
    '    signal: __lifecycleController.signal,',
    '    onCleanup(callback) {',
    '      if (typeof callback !== "function") throw new TypeError("cleanup callback must be a function");',
    '      if (__lifecycleEnded) { __runCleanup(callback); return () => {}; }',
    '      __lifecycleCleanups.add(callback);',
    '      return () => __lifecycleCleanups.delete(callback);',
    '    },',
    '    timeout(callback, delay) {',
    '      if (typeof callback !== "function") throw new TypeError("timeout callback must be a function");',
    '      if (__lifecycleEnded) return 0;',
    '      let timer;',
    '      timer = window.setTimeout(() => { __lifecycleTimers.delete(timer); if (!__lifecycleEnded) callback(); }, Math.max(0, Number(delay) || 0));',
    '      __lifecycleTimers.set(timer, "timeout");',
    '      return timer;',
    '    },',
    '    interval(callback, delay) {',
    '      if (typeof callback !== "function") throw new TypeError("interval callback must be a function");',
    '      if (__lifecycleEnded) return 0;',
    '      const timer = window.setInterval(() => { if (!__lifecycleEnded) callback(); }, Math.max(1, Number(delay) || 1));',
    '      __lifecycleTimers.set(timer, "interval");',
    '      return timer;',
    '    },',
    '    onUpgrade(callback) {',
    '      if (typeof callback !== "function") throw new TypeError("upgrade callback must be a function");',
    '      if (__lifecycleController.signal.aborted) return () => {};',
    '      __upgradeListeners.add(callback);',
    '      const remove = () => __upgradeListeners.delete(callback);',
    '      __lifecycle.onCleanup(remove);',
    '      return remove;',
    '    },',
    '  });',
    '  let __lastUpgradeKey = "";',
    '  const __onUpgradeMessage = async (message) => {',
    '    if (message?.type !== "CHUDPRESENCE_ACTIVITY_UPGRADE" || message.activityId !== __activityIdentity.activityId ||',
    '        message.activityVersion !== __activityIdentity.activityVersion || typeof message.fromVersion !== "string" ||',
    '        typeof message.toVersion !== "string") return;',
    '    const key = `${message.fromVersion}->${message.toVersion}`;',
    '    if (__lastUpgradeKey === key) return;',
    '    __lastUpgradeKey = key;',
    '    const event = Object.freeze({ fromVersion: message.fromVersion, toVersion: message.toVersion });',
    '    try { for (const callback of [...__upgradeListeners]) await callback(event); }',
    '    catch (__error) {',
    '      let __name = "Error"; let __message = "Activity upgrade migration failed";',
    '      try { if (typeof __error?.name === "string") __name = __error.name.slice(0, 80); } catch {}',
    '      try { if (typeof __error?.message === "string") __message = __error.message.slice(0, 500); } catch {}',
    '      void __request("lifecycle.upgradeError", { fromVersion: message.fromVersion, toVersion: message.toVersion, name: __name, message: __message }).catch(() => {});',
    '      return;',
    '    }',
    '    void __request("lifecycle.upgradeComplete", { fromVersion: message.fromVersion, toVersion: message.toVersion }).catch(() => {});',
    '  };',
    '  __lifecycle.onCleanup(() => { __upgradeListeners.clear(); });',
    '  const __navigationListeners = new Set();',
    '  let __navigationLastUrl = location.href;',
    '  let __navigationPending = null;',
    '  let __navigationQueued = false;',
    '  let __navigationPoll = 0;',
    '  const __checkNavigation = (type = "history") => {',
    '    const newUrl = location.href;',
    '    if (newUrl === __navigationLastUrl) return;',
    '    const oldUrl = __navigationLastUrl;',
    '    __navigationLastUrl = newUrl;',
    '    __navigationPending = __navigationPending',
    '      ? { ...__navigationPending, newUrl, type }',
    '      : { oldUrl, newUrl, type };',
    '    if (__navigationQueued) return;',
    '    __navigationQueued = true;',
    '    Promise.resolve().then(() => {',
    '      __navigationQueued = false;',
    '      const change = __navigationPending;',
    '      __navigationPending = null;',
    '      if (!change || __lifecycleController.signal.aborted || !__navigationListeners.size) return;',
    '      if (location.href !== change.newUrl) { __checkNavigation("history"); return; }',
    '      for (const callback of [...__navigationListeners]) { try { callback(change); } catch {} }',
    '    });',
    '  };',
    '  const __onPopState = () => __checkNavigation("popstate");',
    '  const __onHashChange = () => __checkNavigation("hashchange");',
    '  const __onNavigate = (event) => __checkNavigation(event.navigationType || "navigate");',
    '  const __startNavigation = () => {',
    '    __navigationLastUrl = location.href;',
    '    window.addEventListener("popstate", __onPopState);',
    '    window.addEventListener("hashchange", __onHashChange);',
    '    window.navigation?.addEventListener?.("navigate", __onNavigate);',
    '    if (!__navigationPoll) __navigationPoll = __lifecycle.interval(() => __checkNavigation("history"), 100);',
    '  };',
    '  const __stopNavigation = () => {',
    '    window.removeEventListener("popstate", __onPopState);',
    '    window.removeEventListener("hashchange", __onHashChange);',
    '    window.navigation?.removeEventListener?.("navigate", __onNavigate);',
    '    if (__navigationPoll) { window.clearInterval(__navigationPoll); __lifecycleTimers.delete(__navigationPoll); }',
    '    __navigationListeners.clear();',
    '    __navigationPoll = 0;',
    '  };',
    '  __lifecycle.onCleanup(__stopNavigation);',
    '  const __navigation = Object.freeze({',
    '    get current() { return location.href; },',
    '    onChange(callback, options = {}) {',
    '      if (typeof callback !== "function") throw new TypeError("navigation callback must be a function");',
    '      if (__lifecycleController.signal.aborted) return () => {};',
    '      __navigationListeners.add(callback);',
    '      if (__navigationListeners.size === 1) __startNavigation();',
    '      const remove = () => { __navigationListeners.delete(callback); if (!__navigationListeners.size) __stopNavigation(); };',
    '      __lifecycle.onCleanup(remove);',
    '      if (options.signal?.aborted) remove(); else options.signal?.addEventListener?.("abort", remove, { once: true });',
    '      return remove;',
    '    },',
    '  });',
    '  const __mediaListeners = new Set();',
    '  const __mediaEvents = ["play", "pause", "ended", "timeupdate", "seeking", "seeked", "volumechange", "ratechange", "loadedmetadata", "durationchange"];',
    '  let __mediaObserver = null;',
    '  const __isMediaElement = (element) => Boolean(element && /^(AUDIO|VIDEO)$/i.test(element.tagName || "") &&',
    '    typeof element.currentTime === "number" && typeof element.paused === "boolean");',
    '  const __mediaElements = () => Array.from(document.querySelectorAll("video, audio")).filter(__isMediaElement);',
    '  const __mediaScore = (element, index) => {',
    '    const playing = !element.paused && !element.ended;',
    '    let visible = false;',
    '    try { const rect = element.getBoundingClientRect(); visible = rect.width > 0 && rect.height > 0; } catch {}',
    '    return (playing ? 1000 : 0) + (!element.ended ? 80 : 0) + (element.currentTime > 0 ? 30 : 0) +',
    '      (Number.isFinite(element.duration) && element.duration > 0 ? 20 : 0) + (visible ? 10 : 0) +',
    '      (element.volume > 0 && !element.muted ? 5 : 0) - index / 10000;',
    '  };',
    '  const __findMedia = () => {',
    '    let best = null;',
    '    let bestScore = -Infinity;',
    '    __mediaElements().forEach((element, index) => { const score = __mediaScore(element, index); if (score > bestScore) { best = element; bestScore = score; } });',
    '    return best;',
    '  };',
    '  const __snapshotMedia = (element = __findMedia()) => {',
    '    if (!__isMediaElement(element)) return null;',
    '    const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;',
    '    return { playing: !element.paused && !element.ended, paused: Boolean(element.paused), ended: Boolean(element.ended),',
    '      currentTime: Math.max(0, number(element.currentTime)), duration: Math.max(0, number(element.duration)),',
    '      playbackRate: number(element.playbackRate, 1), volume: Math.min(1, Math.max(0, number(element.volume, 1))), muted: Boolean(element.muted) };',
    '  };',
    '  const __emitMediaChange = (type, element) => {',
    '    if (!__isMediaElement(element)) return;',
    '    const event = { type, element, snapshot: __snapshotMedia(element) };',
    '    for (const callback of [...__mediaListeners]) { try { callback(event); } catch {} }',
    '  };',
    '  const __onMediaEvent = (event) => __emitMediaChange(event.type, event.target);',
    '  const __observeMedia = () => {',
    '    for (const type of __mediaEvents) document.addEventListener(type, __onMediaEvent, true);',
    '    if (typeof MutationObserver === "function" && document.documentElement) {',
    '      __mediaObserver = new MutationObserver(() => { for (const element of __mediaElements()) __emitMediaChange("media-elements-changed", element); });',
    '      __mediaObserver.observe(document.documentElement, { childList: true, subtree: true });',
    '    }',
    '  };',
    '  const __stopMediaObserver = () => {',
    '    for (const type of __mediaEvents) document.removeEventListener(type, __onMediaEvent, true);',
    '    __mediaObserver?.disconnect();',
    '    __mediaObserver = null;',
    '    __mediaListeners.clear();',
    '  };',
    '  __lifecycle.onCleanup(__stopMediaObserver);',
    '  const __media = Object.freeze({',
    '    find() { return __findMedia(); },',
    '    findAll() { return __mediaElements(); },',
    '    snapshot(element) { return __snapshotMedia(element); },',
    '    onChange(callback, options = {}) {',
    '      if (typeof callback !== "function") throw new TypeError("media callback must be a function");',
    '      if (__lifecycleController.signal.aborted) return () => {};',
    '      const wrapped = (event) => { if ((!options.element || options.element === event.element) && (!options.type || options.type === event.type)) callback(event); };',
    '      __mediaListeners.add(wrapped);',
    '      if (__mediaListeners.size === 1) __observeMedia();',
    '      const remove = () => { __mediaListeners.delete(wrapped); if (!__mediaListeners.size) __stopMediaObserver(); };',
    '      __lifecycle.onCleanup(remove);',
    '      if (options.signal?.aborted) remove(); else options.signal?.addEventListener?.("abort", remove, { once: true });',
    '      if (options.immediate) { const element = options.element || __findMedia(); if (element) wrapped({ type: "snapshot", element, snapshot: __snapshotMedia(element) }); }',
    '      return remove;',
    '    },',
    '  });',
    '  const __page = Object.freeze({',
    '    async execute(fn, args = []) {',
    '      if (typeof fn !== "function") throw new TypeError("page.execute expects a function");',
    '      if (!Array.isArray(args)) throw new TypeError("page.execute args must be an array");',
    '      const source = Function.prototype.toString.call(fn);',
    `      if (!source || source.length > ${MAX_PAGE_EXECUTE_SOURCE_LENGTH}) throw new RangeError("page.execute function is too large");`,
    '      let argsJson;',
    '      try { argsJson = JSON.stringify(args); } catch { throw new TypeError("page.execute args must be JSON-compatible"); }',
    '      if (typeof argsJson !== "string" || argsJson.length > ' + MAX_PAGE_EXECUTE_ARGUMENTS_LENGTH + ') throw new RangeError("page.execute args must be JSON-compatible and no larger than 16 KB");',
    '      const response = await __request("page.execute", { source, argsJson });',
    '      if (response?.ok === true) return response.data?.value;',
    '      const details = response?.error || { code: "page_execution_error", name: "Error", message: "Page execution failed" };',
    '      const error = new Error(typeof details.message === "string" ? details.message : "Page execution failed");',
    '      error.name = typeof details.name === "string" ? details.name : "ActivityRuntimeError";',
    '      error.code = typeof details.code === "string" ? details.code : "page_execution_error";',
    '      throw error;',
    '    },',
    '  });',
    '  const __domAbortError = () => { const error = new Error("DOM wait was cancelled"); error.name = "AbortError"; error.code = "aborted"; return error; };',
    '  const __dom = Object.freeze({',
    '    waitFor(selector, options = {}) {',
    '      if (typeof selector !== "string" || !selector.trim() || selector.length > 512) throw new TypeError("dom.waitFor selector must be a non-empty string up to 512 characters");',
    '      const root = options.root || document;',
    '      if (typeof root.querySelector !== "function") throw new TypeError("dom.waitFor root must support querySelector");',
    '      const signals = [__lifecycleController.signal, options.signal].filter(Boolean);',
    '      if (signals.some((signal) => signal.aborted)) return Promise.reject(__domAbortError());',
    '      const timeoutMs = options.timeoutMs === undefined ? 10_000 : Number(options.timeoutMs);',
    '      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new RangeError("dom.waitFor timeoutMs must be from 0 to 300000");',
    '      return new Promise((resolve, reject) => {',
    '        let timer = 0;',
    '        let observer = null;',
    '        let removeLifecycle = () => {};',
    '        let finished = false;',
    '        const cleanup = () => {',
    '          if (timer) window.clearTimeout(timer);',
    '          observer?.disconnect();',
    '          for (const signal of signals) signal.removeEventListener?.("abort", onAbort);',
    '          removeLifecycle();',
    '        };',
    '        const finish = (callback, value) => { if (finished) return; finished = true; cleanup(); callback(value); };',
    '        const onAbort = () => finish(reject, __domAbortError());',
    '        for (const signal of signals) signal.addEventListener?.("abort", onAbort, { once: true });',
    '        removeLifecycle = __lifecycle.onCleanup(onAbort);',
    '        try { const existing = root.querySelector(selector); if (existing) { finish(resolve, existing); return; } }',
    '        catch (error) { finish(reject, error); return; }',
    '        if (typeof MutationObserver !== "function") { finish(reject, new Error("MutationObserver is unavailable")); return; }',
    '        observer = new MutationObserver(() => {',
    '          try { const match = root.querySelector(selector); if (match) finish(resolve, match); }',
    '          catch (error) { finish(reject, error); }',
    '        });',
    '        try { observer.observe(root, { childList: true, subtree: true, attributes: options.attributes === true }); }',
    '        catch (error) { finish(reject, error); return; }',
    '        if (timeoutMs === 0) finish(reject, Object.assign(new Error("Timed out waiting for a DOM element"), { name: "TimeoutError", code: "timeout" }));',
    '        else timer = window.setTimeout(() => finish(reject, Object.assign(new Error("Timed out waiting for a DOM element"), { name: "TimeoutError", code: "timeout" })), timeoutMs);',
    '      });',
    '    },',
    '    observe(selector, callback, options = {}) {',
    '      if (typeof selector !== "string" || !selector.trim() || selector.length > 512) throw new TypeError("dom.observe selector must be a non-empty string up to 512 characters");',
    '      if (typeof callback !== "function") throw new TypeError("dom.observe callback must be a function");',
    '      const root = options.root || document;',
    '      if (typeof root.querySelectorAll !== "function") throw new TypeError("dom.observe root must support querySelectorAll");',
    '      if (__lifecycleController.signal.aborted || options.signal?.aborted) return () => {};',
    '      if (typeof MutationObserver !== "function") throw new Error("MutationObserver is unavailable");',
    '      const emitted = new Set();',
    '      let observer = null;',
    '      let removeLifecycle = () => {};',
    '      const emit = (element) => { if (!emitted.has(element)) { emitted.add(element); try { callback(element, { type: "added" }); } catch {} } };',
    '      const scan = (node) => {',
    '        if (!node || node.nodeType !== 1) return;',
    '        try { if (node.matches(selector)) emit(node); for (const element of node.querySelectorAll(selector)) emit(element); } catch {}',
    '      };',
    '      if (options.immediate !== false) for (const element of root.querySelectorAll(selector)) emit(element);',
    '      observer = new MutationObserver((records) => {',
    '        for (const record of records) {',
    '          if (record.type === "attributes") scan(record.target);',
    '          for (const node of record.addedNodes || []) scan(node);',
    '        }',
    '      });',
    '      observer.observe(root, { childList: true, subtree: true, attributes: options.attributes === true, attributeFilter: options.attributes === true ? options.attributeFilter : undefined });',
    '      const remove = () => { observer?.disconnect(); observer = null; options.signal?.removeEventListener?.("abort", remove); removeLifecycle(); };',
    '      removeLifecycle = __lifecycle.onCleanup(remove);',
    '      options.signal?.addEventListener?.("abort", remove, { once: true });',
    '      return remove;',
    '    },',
    '  });',
    '  const __net = Object.freeze({',
    '    async fetch(url, options = {}) {',
    '      if (typeof url !== "string") throw new TypeError("net.fetch URL must be a string");',
    '      if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("net.fetch options must be an object");',
    '      const response = await __request("net.fetch", { url, options });',
    '      if (response?.ok === true) return response.data;',
    '      const details = response?.error || { code: "network_error", name: "Error", message: "Activity network request failed" };',
    '      const error = new Error(typeof details.message === "string" ? details.message : "Activity network request failed");',
    '      error.name = typeof details.name === "string" ? details.name : "ActivityNetworkError";',
    '      error.code = typeof details.code === "string" ? details.code : "network_error";',
    '      throw error;',
    '    },',
    '  });',
    '  const __storageRequest = async (operation, payload = {}) => {',
    '    const response = await __request(operation, payload);',
    '    if (response?.ok === true) return response.data?.value;',
    '    const details = response?.error || { code: "storage_error", name: "Error", message: "Activity storage failed" };',
    '    const error = new Error(typeof details.message === "string" ? details.message : "Activity storage failed");',
    '    error.name = typeof details.name === "string" ? details.name : "ActivityStorageError";',
    '    error.code = typeof details.code === "string" ? details.code : "storage_error";',
    '    throw error;',
    '  };',
    '  const __storage = Object.freeze({',
    '    get(key) { return __storageRequest("storage.get", { key }); },',
    '    set(key, value) {',
    '      let serialized;',
    '      try { serialized = JSON.stringify(value); } catch { throw new TypeError("storage values must be JSON-compatible"); }',
    '      if (typeof serialized !== "string") throw new TypeError("storage values must be JSON-compatible");',
    '      return __storageRequest("storage.set", { key, value: JSON.parse(serialized) });',
    '    },',
    '    remove(key) { return __storageRequest("storage.remove", { key }); },',
    '    clear() { return __storageRequest("storage.clear"); },',
    '  });',
    '  const __settingsListeners = new Set();',
    '  const __settingsRequest = async (operation, payload = {}) => {',
    '    const response = await __request(operation, payload);',
    '    if (response?.ok === true) return response.data?.value;',
    '    const details = response?.error || { code: "settings_error", name: "Error", message: "Activity settings failed" };',
    '    const error = new Error(typeof details.message === "string" ? details.message : "Activity settings failed");',
    '    error.name = typeof details.name === "string" ? details.name : "ActivitySettingsError";',
    '    error.code = typeof details.code === "string" ? details.code : "settings_error";',
    '    throw error;',
    '  };',
    '  const __onSettingsChanged = (message) => {',
    '    if (message?.type !== "CHUDPRESENCE_ACTIVITY_SETTINGS_CHANGED" ||',
    '        message.activityId !== __activityIdentity.activityId || message.activityVersion !== __activityIdentity.activityVersion) return;',
    '    const event = Object.freeze({ id: message.settingId, value: message.value, settings: message.settings });',
    '    for (const callback of [...__settingsListeners]) { try { callback(event); } catch {} }',
    '  };',
    '  __lifecycle.onCleanup(() => { __settingsListeners.clear(); });',
    '  const __settings = Object.freeze({',
    '    get(id) { return __settingsRequest("settings.get", { id }); },',
    '    getAll() { return __settingsRequest("settings.getAll"); },',
    '    onChange(callback) {',
    '      if (typeof callback !== "function") throw new TypeError("settings callback must be a function");',
    '      if (__lifecycleController.signal.aborted) return () => {};',
    '      __settingsListeners.add(callback);',
    '      const remove = () => __settingsListeners.delete(callback);',
    '      __lifecycle.onCleanup(remove);',
    '      return remove;',
    '    },',
    '  });',
    '  const __writeLog = async (level, args) => {',
    '    if (!Array.isArray(args) || args.length > 8) throw new TypeError("Activity logs accept at most eight values");',
    '    let serialized;',
    '    try { serialized = JSON.stringify(args); } catch { throw new TypeError("Activity log values must be JSON-compatible"); }',
    '    if (typeof serialized !== "string" || serialized.length > 4096) throw new RangeError("Activity log entry exceeds 4 KB");',
    '    const response = await __request("log.write", { level, args: JSON.parse(serialized) });',
    '    if (response?.ok === true) return true;',
    '    const details = response?.error || { code: "log_error", name: "Error", message: "Activity log could not be recorded" };',
    '    const error = new Error(typeof details.message === "string" ? details.message : "Activity log could not be recorded");',
    '    error.name = typeof details.name === "string" ? details.name : "ActivityLogError";',
    '    error.code = typeof details.code === "string" ? details.code : "log_error";',
    '    throw error;',
    '  };',
    '  const __log = Object.freeze({',
    '    debug(...args) { return __writeLog("debug", args); },',
    '    info(...args) { return __writeLog("info", args); },',
    '    warn(...args) { return __writeLog("warn", args); },',
    '    error(...args) { return __writeLog("error", args); },',
    '  });',
    '  const __features = Object.freeze({ report: true, clear: true, lifecycle: true, navigation: true, media: true, pageExecute: true, netFetch: true, storage: true, settings: true, dom: true, log: true });',
    '  const __emptyNamespace = Object.freeze({});',
    '  const ChudPresence = Object.freeze({',
    '    report(report) { return __request("presence.report", { report }); },',
    '    clear() { return __request("presence.clear"); },',
    '    runtime: Object.freeze({',
    '      activityId: __activityIdentity.activityId,',
    '      activityVersion: __activityIdentity.activityVersion,',
    '      apiVersion: __activityIdentity.apiVersion,',
    '      extensionVersion: __activityIdentity.extensionVersion,',
    '      frame: Object.freeze({ isTop: window === window.top }),',
    '      has(feature) { return __features[feature] === true; },',
    '    }),',
    '    lifecycle: __lifecycle,',
    '    navigation: __navigation,',
    '    media: __media,',
    '    page: __page,',
    '    frames: __emptyNamespace,',
    '    net: __net,',
    '    storage: __storage,',
    '    settings: __settings,',
    '    dom: __dom,',
    '    log: __log,',
    '  });',
    '  const __safeGlobals = new WeakMap();',
    '  const __safeGlobal = (target) => {',
    '    if (!target || (typeof target !== "object" && typeof target !== "function")) return target;',
    '    if (__safeGlobals.has(target)) return __safeGlobals.get(target);',
    '    const proxy = new Proxy(target, {',
    '      get(object, key) {',
    '        if (key === "browser" || key === "chrome") return undefined;',
    '        const value = Reflect.get(object, key, object);',
    '        if (["window", "self", "top", "parent", "globalThis"].includes(key) && value) return __safeGlobal(value);',
    '        return typeof value === "function" ? value.bind(object) : value;',
    '      },',
    '    });',
    '    __safeGlobals.set(target, proxy);',
    '    return proxy;',
    '  };',
    '  const __activityWindow = __safeGlobal(window);',
    '  const __runActivity = (ChudPresence, browser, chrome, globalThis, window, self, top) => {',
    record.code,
    '  };',
    '  __runActivity(ChudPresence, undefined, undefined, __activityWindow, __activityWindow, __activityWindow, __activityWindow);',
    '  try {',
    '    __runtimePort = browser.runtime.connect({ name: `chudpresence-activity-v1:${__activityIdentity.activityVersion}` });',
    '    __runtimePort.onMessage.addListener((message) => {',
    '      if (__matchesActivity(message)) __endLifecycle(message.reason || "activity-stopped");',
    '      else if (message?.type === "CHUDPRESENCE_ACTIVITY_UPGRADE") void __onUpgradeMessage(message);',
    '      else if (message?.type === "CHUDPRESENCE_ACTIVITY_SETTINGS_CHANGED") __onSettingsChanged(message);',
    '    });',
    '    __runtimePort.onDisconnect.addListener(() => __endLifecycle("runtime-disconnected"));',
    '  } catch {}',
    '})();',
  ].join('\n');
  return {
    id: activityScriptId(id),
    worldId: activityWorldId(id),
    world: 'USER_SCRIPT',
    matches: [...record.metadata.matches],
    allFrames: record.metadata.frames === 'all',
    runAt: 'document_idle',
    js: [{ code }],
  };
}

function extensionVersion(api) {
  try {
    return api.runtime?.getManifest?.().version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
  constructor({ api = extensionApi(), onReport = () => {}, onClear = () => {}, fetchImpl = globalThis.fetch } = {}) {
    if (!api?.storage?.local) throw new Error('Extension storage API is required.');
    this.api = api;
    this.onReport = onReport;
    this.onClear = onClear;
    this.fetchImpl = fetchImpl;
    this.records = null;
    this.lastSeen = new Map();
    this.reportRates = new Map();
    this.activeNetworkRequests = 0;
    this.activeNetworkByActivity = new Map();
    this.networkDiagnostics = [];
    this.activityDiagnostics = new Map();
    this.activityLogs = [];
    this.pendingUpgradeNotifications = new Set();
    this.activityPorts = new Map();
    this.upgradeNotificationPorts = new WeakMap();
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
      const tabFrames = this.lastSeen.get(record.metadata.id);
      const frameContexts = [...(tabFrames?.values() || [])]
        .flatMap((frames) => [...frames.values()])
        .filter((seen) => now - seen.lastSeen < STATUS_TTL_MS)
        .sort((a, b) => b.lastSeen - a.lastSeen);
      const seenEntries = frameContexts.filter((seen) => seen.active !== false);
      const seen = seenEntries[0];
      const detected = Boolean(seen);
      const diagnostics = this.activityDiagnostics.get(record.metadata.id) || {};
      const runtimeVersion = extensionVersion(this.api);
      const compatibilityStatus = !isSupportedActivityApiVersion(record.metadata.apiVersion)
        ? `Requires Activity API v${record.metadata.apiVersion}`
        : record.metadata.minExtensionVersion && compareActivityVersions(runtimeVersion, record.metadata.minExtensionVersion) < 0
          ? `Requires ChudPresence v${record.metadata.minExtensionVersion} or newer`
          : '';
      return {
        id: record.metadata.id,
        name: record.metadata.name,
        description: record.metadata.description,
        version: record.metadata.version,
        apiVersion: record.metadata.apiVersion,
        compatibilityStatus,
        matches: Array.isArray(record.metadata.matches) ? [...record.metadata.matches] : [],
        network: Array.isArray(record.metadata.network) ? [...record.metadata.network] : [],
        settings: Array.isArray(record.metadata.settings) ? structuredClone(record.metadata.settings) : [],
        settingValues: normalizeActivitySettings(record.metadata.settings || [], record.settingValues),
        rawReport: diagnostics.rawReport || null,
        normalizedReport: diagnostics.normalizedReport || null,
        lastReport: diagnostics.lastReport || null,
        lastClear: diagnostics.lastClear || null,
        lastError: diagnostics.lastError || null,
        lastUpgrade: diagnostics.lastUpgrade || null,
        pendingUpgrade: record.pendingUpgrade ? { ...record.pendingUpgrade } : null,
        activityLogs: this.activityLogs
          .filter((entry) => entry.activityId === record.metadata.id)
          .slice(-10),
        frames: record.metadata.frames || 'top',
        category: record.metadata.category || 'other',
        enabled: record.enabled === true,
        source: record.source && typeof record.source === 'object'
          ? { ...record.source }
          : { type: 'local' },
        preferences: normalizeActivityPreferences(record.preferences),
        icon: record.icon ? `data:image/png;base64,${record.icon}` : '',
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        status: compatibilityStatus
          ? 'incompatible'
          : !record.enabled
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
        activeFrames: seenEntries.map((context) => ({
          frameId: context.frameId,
          parentFrameId: context.parentFrameId,
          documentId: context.documentId,
          senderUrl: context.senderUrl,
          lastSeen: context.lastSeen,
        })),
        frameContexts: frameContexts.map((context) => ({
          frameId: context.frameId,
          parentFrameId: context.parentFrameId,
          state: context.active === false ? 'retired' : 'active',
          documentId: context.documentId || context.lastDocumentId || null,
          senderUrl: context.senderUrl,
          retiredDocumentIds: [...(context.retiredDocumentIds || [])],
          lastSeen: context.lastSeen,
        })),
        networkRequests: this.networkDiagnostics
          .filter((request) => request.activityId === record.metadata.id)
          .slice(-10)
          .map((request) => ({
            activityId: request.activityId,
            activityName: request.activityName,
            requestId: request.requestId,
            tabId: request.tabId,
            frameId: request.frameId,
            documentId: request.documentId,
            senderUrl: request.senderUrl,
            url: request.url,
            method: request.method,
            state: request.state,
            status: request.status,
            responseBytes: request.responseBytes,
            durationMs: request.durationMs,
            errorCode: request.errorCode,
            startedAt: request.startedAt,
          })),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id) {
    return (await this.load())[id] || null;
  }

  preferencesFor(id) {
    return normalizeActivityPreferences(this.records?.[id]?.preferences);
  }

  settingsFor(id) {
    const record = this.records?.[id];
    if (!record) return {};
    return normalizeActivitySettings(record.metadata?.settings || [], record.settingValues);
  }

  recordActivityError(id, sender, code, message) {
    const previous = this.activityDiagnostics.get(id) || {};
    previous.lastError = {
      timestamp: new Date().toISOString(),
      code: String(code || 'activity_error').slice(0, 80),
      message: String(sanitizeDiagnosticValue(String(message || 'Activity operation failed'), 'message')).slice(0, 512),
      tabId: sender?.tab?.id ?? null,
      frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null,
      documentId: sender?.documentId || null,
      senderUrl: safeDiagnosticUrl(sender?.url || ''),
    };
    this.activityDiagnostics.set(id, previous);
  }

  executeActivityLog(id, record, sender, request) {
    const levels = new Set(['debug', 'info', 'warn', 'error']);
    if (!levels.has(request?.level) || !Array.isArray(request.args) || request.args.length > 8) {
      const error = new TypeError('Activity log entries need a supported level and at most eight values.');
      error.code = 'invalid_log_entry';
      throw error;
    }
    let serialized;
    try { serialized = JSON.stringify(request.args); } catch {
      const error = new TypeError('Activity log values must be JSON-compatible.');
      error.code = 'invalid_log_entry';
      throw error;
    }
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_ACTIVITY_LOG_ENTRY_BYTES) {
      const error = new RangeError('Activity log entry exceeds 4 KB.');
      error.code = 'log_entry_too_large';
      throw error;
    }
    this.activityLogs.push({
      activityId: id,
      activityName: record.metadata.name,
      activityVersion: record.metadata.version,
      tabId: sender?.tab?.id ?? null,
      frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null,
      documentId: sender?.documentId || null,
      timestamp: new Date().toISOString(),
      level: request.level,
      args: sanitizeDiagnosticValue(request.args),
    });
    if (this.activityLogs.length > MAX_ACTIVITY_LOGS) {
      this.activityLogs.splice(0, this.activityLogs.length - MAX_ACTIVITY_LOGS);
    }
    return { value: true };
  }

  recordActivityClear(id, sender, reason = 'cleared') {
    const previous = this.activityDiagnostics.get(id) || {};
    previous.lastClear = {
      timestamp: new Date().toISOString(),
      reason,
      tabId: sender?.tab?.id ?? null,
      frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null,
      documentId: sender?.documentId || null,
    };
    this.activityDiagnostics.set(id, previous);
  }

  setActivitySetting(id, settingId, value) {
    return this.serialize(() => this.setActivitySettingInternal(id, settingId, value));
  }

  async setActivitySettingInternal(id, settingId, value) {
    const record = (await this.load())[id];
    if (!record) throw new Error(`Activity ${id} is not installed.`);
    const definitions = record.metadata.settings || [];
    const previous = normalizeActivitySettings(definitions, record.settingValues);
    const next = mergeActivitySetting(definitions, previous, settingId, value);
    if (Object.is(previous[settingId], next[settingId])) return { id, settingId, value: next[settingId], settings: next };
    record.settingValues = next;
    try {
      await this.save();
    } catch (error) {
      record.settingValues = previous;
      throw error;
    }
    await this.notifyActivitySettingsChanged(id, settingId);
    return { id, settingId, value: next[settingId], settings: next };
  }

  async notifyActivitySettingsChanged(id, settingId) {
    const record = this.records?.[id];
    if (!record) return 0;
    const settings = this.settingsFor(id);
    const message = {
      type: 'CHUDPRESENCE_ACTIVITY_SETTINGS_CHANGED',
      activityId: id,
      activityVersion: record?.metadata?.version || '',
      settingId,
      value: settings[settingId],
      settings,
    };
    let notified = 0;
    for (const [port, context] of this.activityPorts.get(id) || []) {
      try {
        port.postMessage(message);
        notified += 1;
      } catch {
        this.disconnectActivityPort(id, port);
      }
    }
    return notified;
  }

  async handleUserScriptConnect(port) {
    const sender = port?.sender;
    const worldId = sender?.userScriptWorldId;
    if (typeof worldId !== 'string' || !worldId.startsWith(WORLD_ID_PREFIX)) return false;
    const id = worldId.slice(WORLD_ID_PREFIX.length);
    const record = (await this.load())[id];
    if (!record || record.metadata.id !== id || !record.enabled ||
        port.name !== `chudpresence-activity-v1:${record.metadata.version}` ||
        typeof sender?.tab?.id !== 'number' || !Number.isInteger(sender.frameId) ||
        typeof sender.documentId !== 'string' || !sender.documentId ||
        !record.metadata.matches.some((pattern) => safeMatch(pattern, sender.url || '')) ||
        (record.metadata.excludeMatches || []).some((pattern) => safeMatch(pattern, sender.url || ''))) return false;

    if (!this.activityPorts.has(id)) this.activityPorts.set(id, new Map());
    const ports = this.activityPorts.get(id);
    ports.set(port, {
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      senderUrl: sender.url || '',
    });
    port.onDisconnect?.addListener?.(() => this.disconnectActivityPort(id, port));
    if (record.pendingUpgrade) await this.notifyPendingUpgrade(id, record, port, sender);
    return true;
  }

  disconnectActivityPort(id, port) {
    const ports = this.activityPorts.get(id);
    if (ports) {
      ports.delete(port);
      if (!ports.size) this.activityPorts.delete(id);
    }
    const upgradeKey = this.upgradeNotificationPorts.get(port);
    if (upgradeKey) this.pendingUpgradeNotifications.delete(upgradeKey);
    this.upgradeNotificationPorts.delete(port);
    return Boolean(ports);
  }

  async installedScripts() {
    if (!this.api.userScripts) return [];
    return this.api.userScripts.getScripts();
  }

  async register(record) {
    validateActivityMetadata(record?.metadata);
    validateActivitySource(record?.code);
    if (!isSupportedActivityApiVersion(record.metadata.apiVersion)) {
      throw new Error(`Activity API version ${record.metadata.apiVersion} is not supported.`);
    }
    if (record.metadata.minExtensionVersion &&
        compareActivityVersions(extensionVersion(this.api), record.metadata.minExtensionVersion) < 0) {
      throw new Error(`This Activity requires ChudPresence v${record.metadata.minExtensionVersion} or newer.`);
    }
    if (!await hasUserScriptsPermission(this.api)) {
      throw new Error('Grant the userScripts permission before installing an Activity.');
    }
    if (!this.api.userScripts) throw new Error('Firefox userScripts API is unavailable.');
    if (!await hasHostPermissions([...record.metadata.matches, ...(record.metadata.network || [])], this.api)) {
      throw new Error('Grant every website and network permission requested by this Activity first.');
    }

    const definition = scriptDefinition(record, extensionVersion(this.api));
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
    if (!isSupportedActivityApiVersion(metadata.apiVersion)) throw new Error('This Activity requires an unsupported API version.');
    const code = validateActivitySource(activityPackage?.source);
    const icon = validateActivityIcon(activityPackage?.icon);
    if (Boolean(metadata.icon) !== Boolean(icon)) {
      throw new Error('Activity icon metadata and package icon must be supplied together.');
    }
    const sourceType = activityPackage?.sourceType === 'repository' ? 'repository' : 'local';
    let source = { type: 'local' };
    if (sourceType === 'repository') {
      const provenance = activityPackage?.provenance;
      if (!provenance || provenance.repository !== 'ChudForks/ChudPresence-Activities' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(provenance.revision || '') ||
          !/^[a-f0-9]{64}$/i.test(provenance.codeSha256 || '') ||
          !/^[a-f0-9]{64}$/i.test(provenance.metadataSha256 || '') ||
          (icon && !/^[a-f0-9]{64}$/i.test(provenance.iconSha256 || '')) ||
          (!icon && provenance.iconSha256 !== undefined)) {
        throw new Error('Repository Activity package is missing valid immutable provenance. Refresh the catalog and retry.');
      }
      if (await sha256Hex(code) !== provenance.codeSha256.toLowerCase()) {
        throw new Error('Repository Activity code no longer matches its provenance hash.');
      }
      if (typeof activityPackage.metadataSource !== 'string' ||
          await sha256Hex(activityPackage.metadataSource) !== provenance.metadataSha256.toLowerCase()) {
        throw new Error('Repository Activity metadata no longer matches its provenance hash.');
      }
      let sourceMetadata;
      try { sourceMetadata = validateActivityMetadata(JSON.parse(activityPackage.metadataSource)); }
      catch { throw new Error('Repository Activity source metadata is invalid.'); }
      if (JSON.stringify(sourceMetadata) !== JSON.stringify(metadata)) {
        throw new Error('Repository Activity metadata does not match its source package.');
      }
      if (icon) {
        const iconBytes = Uint8Array.from(atob(icon), (character) => character.charCodeAt(0));
        if (await sha256Hex(iconBytes) !== provenance.iconSha256.toLowerCase()) {
          throw new Error('Repository Activity icon no longer matches its provenance hash.');
        }
      }
      source = {
        type: 'repository',
        repository: provenance.repository,
        revision: provenance.revision.toLowerCase(),
        codeSha256: provenance.codeSha256.toLowerCase(),
        metadataSha256: provenance.metadataSha256.toLowerCase(),
        ...(icon ? { iconSha256: provenance.iconSha256.toLowerCase() } : {}),
      };
    }
    const records = await this.load();
    const previous = records[metadata.id];
    const now = Date.now();
    const record = {
      metadata,
      code,
      enabled: true,
      installedAt: previous?.installedAt || now,
      updatedAt: now,
      source,
      preferences: normalizeActivityPreferences(previous?.preferences),
      settingValues: normalizeActivitySettings(metadata.settings || [], previous?.settingValues),
      ...(previous && (previous.pendingUpgrade || previous.metadata.version !== metadata.version)
        ? (() => {
            const fromVersion = previous.pendingUpgrade?.fromVersion || previous.metadata.version;
            return fromVersion === metadata.version
              ? {}
              : { pendingUpgrade: { fromVersion, toVersion: metadata.version } };
          })()
        : {}),
      ...(icon ? { icon } : {}),
    };

    if (previous) await this.notifyActivityTeardown(metadata.id, 'updated');
    try {
      await this.register(record);
    } catch (error) {
      if (previous) {
        await this.register(previous).catch(() => {});
        await this.reloadInternal(metadata.id).catch(() => {});
      }
      throw error;
    }
    records[metadata.id] = record;
    try {
      await this.save();
    } catch (error) {
      if (previous) records[metadata.id] = previous;
      else delete records[metadata.id];
      if (previous) {
        await this.register(previous).catch(() => {});
        await this.reloadInternal(metadata.id).catch(() => {});
      } else {
        await this.unregister(metadata.id).catch(() => {});
      }
      throw error;
    }
    if (previous) {
      await this.reloadInternal(metadata.id).catch((error) => {
        this.recordActivityError(metadata.id, null, 'reload_failed', error.message || 'Activity update reload failed.');
      });
      await this.removeUnusedHostPermissions([
        ...(Array.isArray(previous.metadata?.matches) ? previous.metadata.matches : []),
        ...(Array.isArray(previous.metadata?.network) ? previous.metadata.network : []),
      ], records);
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

  reload(id) {
    return this.serialize(() => this.reloadInternal(id));
  }

  async reloadInternal(id) {
    const record = (await this.load())[id];
    if (!record || !record.enabled) throw new Error(`Enabled Activity ${id} is not installed.`);
    const currentContexts = [];
    for (const [tabId, frames] of this.lastSeen.get(id) || []) {
      for (const [frameId, context] of frames) {
        if (context.active !== false && context.documentId) currentContexts.push({ tabId, frameId, ...context });
      }
    }
    await this.notifyActivityTeardown(id, 'reloaded');
    for (const context of currentContexts) {
      await this.onClear(id, context.tabId, context.documentId, context.frameId);
    }
    this.lastSeen.delete(id);
    await this.register(record);
    let reloadedFrames = 0;
    for (const context of currentContexts) {
      const results = await this.api.userScripts.execute({
        js: scriptDefinition(record, extensionVersion(this.api)).js,
        target: { tabId: context.tabId, documentIds: [context.documentId] },
        world: 'USER_SCRIPT',
        worldId: activityWorldId(id),
        injectImmediately: true,
      });
      const result = Array.isArray(results) ? results[0] : null;
      if (result?.error) {
        this.recordActivityError(id, { tab: { id: context.tabId }, frameId: context.frameId, documentId: context.documentId, url: context.senderUrl }, 'reload_failed', result.error);
        throw new Error(`Could not reload Activity in frame ${context.frameId}: ${result.error}`);
      }
      if (!result || (result.documentId && result.documentId !== context.documentId)) {
        throw new Error(`Activity document changed while reloading frame ${context.frameId}.`);
      }
      reloadedFrames += 1;
    }
    return { id, reloadedFrames };
  }

  async removeInternal(id) {
    const records = await this.load();
    if (!records[id]) return false;
    const previous = records[id];
    await this.notifyActivityTeardown(id, 'uninstalled');
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
    try {
      await this.clearActivityStorage(id);
    } catch (error) {
      records[id] = previous;
      await this.save().catch(() => {});
      if (previous.enabled) await this.register(previous).catch(() => {});
      throw error;
    }
    this.activityDiagnostics.delete(id);
    this.activityLogs = this.activityLogs.filter((entry) => entry.activityId !== id);
    const removedPatterns = [
      ...(Array.isArray(previous.metadata?.matches) ? previous.metadata.matches : []),
      ...(Array.isArray(previous.metadata?.network) ? previous.metadata.network : []),
    ];
    await this.removeUnusedHostPermissions(removedPatterns, records);
    return true;
  }

  async removeUnusedHostPermissions(removedMatches, remainingRecords) {
    if (typeof this.api.permissions?.remove !== 'function') return false;
    const permissionOrigin = (pattern) => {
      const match = String(pattern).match(/^(https?):\/\/([^/]+)\//i);
      return match ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}/*` : '';
    };
    const stillUsed = new Set(Object.values(remainingRecords)
      .filter((record) => record?.metadata && Array.isArray(record.metadata.matches))
      .flatMap((record) => [
        ...record.metadata.matches,
        ...(Array.isArray(record.metadata.network) ? record.metadata.network : []),
      ].map(permissionOrigin)));
    const unused = [...new Set(removedMatches.map(permissionOrigin))]
      .filter((origin) => origin && !stillUsed.has(origin));
    if (!unused.length) return true;
    try {
      return await this.api.permissions.remove({ origins: unused });
    } catch {
      return false;
    }
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
      await this.notifyActivityTeardown(id, 'disabled');
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
          await this.notifyActivityTeardown(record.metadata.id, 'permission-lost');
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
      if (!isSupportedActivityApiVersion(record.metadata?.apiVersion)) {
        record.compatibilityStatus = `Requires Activity API v${record.metadata.apiVersion}`;
        record.error = record.compatibilityStatus;
        await this.unregister(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      if (record.metadata.minExtensionVersion &&
          compareActivityVersions(extensionVersion(this.api), record.metadata.minExtensionVersion) < 0) {
        record.compatibilityStatus = `Requires ChudPresence v${record.metadata.minExtensionVersion} or newer`;
        record.error = record.compatibilityStatus;
        await this.unregister(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      try {
        record.metadata = validateActivityMetadata(record.metadata);
        validateActivitySource(record.code);
        delete record.compatibilityStatus;
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
      if (!await hasHostPermissions([...record.metadata.matches, ...(record.metadata.network || [])], this.api)) {
        record.permissionMissing = true;
        await this.notifyActivityTeardown(record.metadata.id, 'permission-lost');
        await this.unregister(record.metadata.id).catch(() => {});
        this.lastSeen.delete(record.metadata.id);
        await this.onClear(record.metadata.id);
        continue;
      }
      record.permissionMissing = false;
      try {
        const exists = registered.some((script) => script.id === activityScriptId(record.metadata.id));
        const definition = scriptDefinition(record, extensionVersion(this.api));
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

  async executeNetworkRequest(id, record, sender, requestId, request) {
    const startedAt = Date.now();
    const options = isPlainObject(request?.options) ? request.options : {};
    const diagnostic = {
      activityId: id,
      activityName: record.metadata.name,
      requestId,
      tabId: sender.tab.id,
      frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
      documentId: sender.documentId || null,
      senderUrl: safeDiagnosticUrl(sender.url || ''),
      url: safeDiagnosticUrl(typeof request?.url === 'string' ? request.url : ''),
      method: typeof options.method === 'string' ? options.method.toUpperCase().slice(0, 8) : 'GET',
      state: 'pending',
      startedAt,
      durationMs: 0,
      status: null,
      responseBytes: 0,
      errorCode: '',
    };
    this.networkDiagnostics.push(diagnostic);
    while (this.networkDiagnostics.length > MAX_NETWORK_DIAGNOSTICS) this.networkDiagnostics.shift();
    const finish = (state, fields = {}) => {
      Object.assign(diagnostic, fields, { state, durationMs: Math.max(0, Date.now() - startedAt) });
    };
    let active = false;
    let timer = 0;
    let controller;
    let timeoutReject;
    try {
      if (!isPlainObject(request) || typeof request.url !== 'string') {
        const error = new TypeError('A network URL is required.');
        error.code = 'invalid_request';
        throw error;
      }
      let url;
      try {
        url = new URL(request.url);
      } catch {
        const error = new TypeError('The network URL is invalid.');
        error.code = 'invalid_url';
        throw error;
      }
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
        const error = new TypeError('Network URLs must be HTTPS and cannot contain credentials or fragments.');
        error.code = 'invalid_url';
        throw error;
      }
      if (isProtectedPage(url.href)) {
        const error = new TypeError('Discord network endpoints are reserved for extension core.');
        error.code = 'protected_endpoint';
        throw error;
      }
      const networkPatterns = Array.isArray(record.metadata.network) ? record.metadata.network : [];
      const matchedPattern = networkPatterns.find((pattern) => safeMatch(pattern, url.href));
      if (!matchedPattern) {
        const error = new TypeError('This network origin is not declared in the Activity metadata.');
        error.code = 'origin_not_declared';
        throw error;
      }
      if (!await hasHostPermissions([matchedPattern], this.api)) {
        const error = new Error('Grant this declared network origin before using it.');
        error.code = 'host_permission_missing';
        throw error;
      }
      if (typeof this.fetchImpl !== 'function') {
        const error = new Error('Extension network access is unavailable.');
        error.code = 'network_unavailable';
        throw error;
      }
      const allowedOptions = new Set(['method', 'headers', 'body', 'json', 'responseType', 'timeoutMs']);
      if (!isPlainObject(request.options || {}) || Object.keys(options).some((key) => !allowedOptions.has(key))) {
        const error = new TypeError('Network options contain an unsupported field.');
        error.code = 'invalid_options';
        throw error;
      }
      const method = options.method === undefined ? 'GET' : options.method;
      if (typeof method !== 'string' || !['GET', 'POST'].includes(method.toUpperCase())) {
        const error = new TypeError('Only GET and POST network requests are supported.');
        error.code = 'invalid_method';
        throw error;
      }
      const normalizedMethod = method.toUpperCase();
      const responseType = options.responseType === undefined ? 'json' : options.responseType;
      if (responseType !== 'json' && responseType !== 'text') {
        const error = new TypeError('responseType must be json or text.');
        error.code = 'invalid_response_type';
        throw error;
      }
      const timeoutMs = options.timeoutMs === undefined ? DEFAULT_NETWORK_TIMEOUT_MS : options.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_NETWORK_TIMEOUT_MS || timeoutMs > MAX_NETWORK_TIMEOUT_MS) {
        const error = new RangeError(`timeoutMs must be between ${MIN_NETWORK_TIMEOUT_MS} and ${MAX_NETWORK_TIMEOUT_MS}.`);
        error.code = 'invalid_timeout';
        throw error;
      }
      const hasBody = Object.hasOwn(options, 'body');
      const hasJson = Object.hasOwn(options, 'json');
      if (hasBody && hasJson) {
        const error = new TypeError('Specify body or json, but not both.');
        error.code = 'invalid_body';
        throw error;
      }
      if (normalizedMethod === 'GET' && (hasBody || hasJson)) {
        const error = new TypeError('GET requests cannot include a body.');
        error.code = 'invalid_body';
        throw error;
      }
      let body;
      if (hasJson) {
        try {
          body = JSON.stringify(options.json);
        } catch {
          const error = new TypeError('json must be JSON-compatible.');
          error.code = 'invalid_body';
          throw error;
        }
        if (typeof body !== 'string') {
          const error = new TypeError('json must be JSON-compatible.');
          error.code = 'invalid_body';
          throw error;
        }
      } else if (hasBody) {
        if (typeof options.body !== 'string') {
          const error = new TypeError('body must be a string.');
          error.code = 'invalid_body';
          throw error;
        }
        body = options.body;
      }
      if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_NETWORK_REQUEST_BODY_BYTES) {
        const error = new RangeError('Network request bodies are limited to 64 KB.');
        error.code = 'request_body_too_large';
        throw error;
      }
      const headers = {};
      let headerBytes = 0;
      if (options.headers !== undefined && !isPlainObject(options.headers)) {
        const error = new TypeError('headers must be a plain object of string values.');
        error.code = 'invalid_headers';
        throw error;
      }
      const providedHeaders = options.headers || {};
      if (Object.keys(providedHeaders).length > 32) {
        const error = new RangeError('A network request can include at most 32 headers.');
        error.code = 'invalid_headers';
        throw error;
      }
      for (const [name, value] of Object.entries(providedHeaders)) {
        const lowerName = name.toLowerCase();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== 'string' || value.length > 2048 ||
            ['cookie', 'cookie2', 'host', 'content-length', 'origin', 'referer'].includes(lowerName) ||
            lowerName.startsWith('sec-') || lowerName.startsWith('proxy-')) {
          const error = new TypeError(`The ${name.slice(0, 64)} header is not allowed.`);
          error.code = 'invalid_headers';
          throw error;
        }
        headerBytes += name.length + value.length;
        if (headerBytes > 8192) {
          const error = new RangeError('Network request headers are limited to 8 KB.');
          error.code = 'invalid_headers';
          throw error;
        }
        headers[name] = value;
      }
      const headerNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
      if (!headerNames.has('accept')) headers.Accept = responseType === 'json' ? 'application/json' : 'text/plain, */*;q=0.1';
      if (hasJson && !headerNames.has('content-type')) headers['Content-Type'] = 'application/json';

      const activeForActivity = this.activeNetworkByActivity.get(id) || 0;
      if (this.activeNetworkRequests >= MAX_NETWORK_GLOBAL_CONCURRENCY || activeForActivity >= MAX_NETWORK_ACTIVITY_CONCURRENCY) {
        const error = new Error('Too many Activity network requests are already running.');
        error.code = 'network_busy';
        throw error;
      }
      this.activeNetworkRequests += 1;
      this.activeNetworkByActivity.set(id, activeForActivity + 1);
      active = true;
      controller = new AbortController();
      const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(`Network request timed out after ${timeoutMs} ms.`);
        error.code = 'timeout';
        timeoutReject(error);
      }, timeoutMs);
      const requestPromise = (async () => {
        const response = await this.fetchImpl(url.href, {
          method: normalizedMethod,
          headers,
          ...(body === undefined ? {} : { body }),
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') {
          const error = new Error('The external service returned an invalid response.');
          error.code = 'network_error';
          throw error;
        }
        diagnostic.status = response.status;
        const { text, byteLength } = await readLimitedResponse(response);
        diagnostic.responseBytes = byteLength;
        let data = text;
        if (responseType === 'json') {
          try {
            data = JSON.parse(text);
          } catch {
            const error = new Error('The external service returned invalid JSON.');
            error.code = 'invalid_json_response';
            throw error;
          }
        }
        return {
          status: response.status,
          ok: response.ok === undefined ? response.status >= 200 && response.status < 300 : Boolean(response.ok),
          contentType: String(response.headers?.get?.('content-type') || '').slice(0, 128),
          data,
        };
      })();
      const response = await Promise.race([requestPromise, timeoutPromise]);
      finish('complete', { status: response.status, responseBytes: diagnostic.responseBytes });
      return { ok: true, data: response };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'network_error';
      const message = String(error?.message || 'Activity network request failed').slice(0, 300);
      finish('error', { errorCode: code });
      return { ok: false, error: { code, name: error?.name || 'Error', message } };
    } finally {
      clearTimeout(timer);
      if (active) {
        this.activeNetworkRequests = Math.max(0, this.activeNetworkRequests - 1);
        const activeForActivity = Math.max(0, (this.activeNetworkByActivity.get(id) || 1) - 1);
        if (activeForActivity) this.activeNetworkByActivity.set(id, activeForActivity);
        else this.activeNetworkByActivity.delete(id);
      }
    }
  }

  activityStorageKey(id, key) {
    return `${ACTIVITY_STORAGE_PREFIX}${id}:${encodeURIComponent(key)}`;
  }

  executeActivityStorage(id, operation, request) {
    return this.serialize(async () => {
      const storage = this.api.storage.local;
      const activityPrefix = `${ACTIVITY_STORAGE_PREFIX}${id}:`;
      const readKey = () => {
        if (typeof request?.key !== 'string' || !request.key || request.key.length > MAX_ACTIVITY_STORAGE_KEY_LENGTH) {
          const error = new TypeError(`Storage keys must be non-empty strings up to ${MAX_ACTIVITY_STORAGE_KEY_LENGTH} characters.`);
          error.code = 'invalid_storage_key';
          throw error;
        }
        try {
          return this.activityStorageKey(id, request.key);
        } catch {
          const error = new TypeError('Storage keys must contain valid Unicode text.');
          error.code = 'invalid_storage_key';
          throw error;
        }
      };

      if (operation === 'storage.get') {
        const key = readKey();
        const result = await storage.get(key);
        return { value: result && Object.hasOwn(result, key) ? result[key] : null };
      }
      if (operation === 'storage.remove') {
        const key = readKey();
        const result = await storage.get(key);
        const existed = Boolean(result && Object.hasOwn(result, key));
        if (existed) await storage.remove(key);
        return { value: existed };
      }
      if (operation === 'storage.clear') {
        const all = await storage.get(null);
        const keys = Object.keys(all || {}).filter((key) => key.startsWith(activityPrefix));
        if (keys.length) await storage.remove(keys);
        return { value: keys.length };
      }
      if (operation === 'storage.set') {
        const key = readKey();
        let serialized;
        try {
          serialized = JSON.stringify(request.value);
        } catch {
          const error = new TypeError('Activity storage values must be JSON-compatible.');
          error.code = 'invalid_storage_value';
          throw error;
        }
        if (typeof serialized !== 'string') {
          const error = new TypeError('Activity storage values must be JSON-compatible.');
          error.code = 'invalid_storage_value';
          throw error;
        }
        const storedValue = JSON.parse(serialized);
        const all = await storage.get(null);
        const encoder = new TextEncoder();
        let usedBytes = 0;
        for (const [storedKey, stored] of Object.entries(all || {})) {
          if (!storedKey.startsWith(activityPrefix) || storedKey === key) continue;
          let storedJson;
          try {
            storedJson = JSON.stringify(stored);
          } catch {
            const error = new Error('Existing Activity storage could not be measured.');
            error.code = 'storage_error';
            throw error;
          }
          if (typeof storedJson !== 'string') {
            const error = new Error('Existing Activity storage could not be measured.');
            error.code = 'storage_error';
            throw error;
          }
          usedBytes += encoder.encode(storedKey).byteLength + encoder.encode(storedJson).byteLength;
        }
        usedBytes += encoder.encode(key).byteLength + encoder.encode(serialized).byteLength;
        if (usedBytes > MAX_ACTIVITY_STORAGE_BYTES) {
          const error = new RangeError('Activity storage is limited to 64 KB.');
          error.code = 'storage_quota_exceeded';
          throw error;
        }
        await storage.set({ [key]: storedValue });
        return { value: true };
      }

      const error = new TypeError('This Activity storage operation is unsupported.');
      error.code = 'unsupported_operation';
      throw error;
    });
  }

  async clearActivityStorage(id) {
    const all = await this.api.storage.local.get(null);
    const prefix = `${ACTIVITY_STORAGE_PREFIX}${id}:`;
    const keys = Object.keys(all || {}).filter((key) => key.startsWith(prefix));
    if (keys.length) await this.api.storage.local.remove(keys);
    return keys.length;
  }

  async notifyActivityTeardown(id, reason) {
    const record = this.records?.[id];
    let notified = 0;
    for (const [port, context] of this.activityPorts.get(id) || []) {
      try {
        port.postMessage({
          type: 'CHUDPRESENCE_ACTIVITY_ABORT',
          activityId: id,
          activityVersion: record?.metadata?.version || '',
          reason,
        });
        notified += 1;
      } catch {
        this.disconnectActivityPort(id, port);
      }
    }
    for (const [tabId, frames] of this.lastSeen.get(id) || []) {
      for (const [frameId, context] of frames) {
        if (context.active === false) continue;
        this.recordActivityClear(id, {
          tab: { id: tabId }, frameId, documentId: context.documentId,
        }, reason);
      }
    }
    return notified;
  }

  async handleUserScriptMessage(message, sender) {
    const structured = message?.type === 'CHUDPRESENCE_ACTIVITY_REQUEST';
    const records = await this.load();
    const worldId = sender?.userScriptWorldId;
    if (typeof worldId !== 'string' || !worldId.startsWith(WORLD_ID_PREFIX)) return false;
    const id = worldId.slice(WORLD_ID_PREFIX.length);
    const record = records[id];
    const tabId = sender?.tab?.id;
    if (!record || record.metadata.id !== id || !record.enabled || typeof tabId !== 'number') return false;
    if (!record.metadata.matches.some((pattern) => safeMatch(pattern, sender.url || ''))) return false;
    if ((record.metadata.excludeMatches || []).some((pattern) => safeMatch(pattern, sender.url || ''))) return false;

    const requestId = structured ? message.requestId : '';
    const respond = (ok, data = null, code = '', description = '', name = '') => {
      if (!ok && structured) this.recordActivityError(id, sender, code, description);
      return structured
        ? {
            ok,
            requestId,
            ...(ok ? { data } : { error: { code, ...(name ? { name } : {}), message: description } }),
          }
        : ok;
    };
    let operation;
    let reportValue;
    let pageRequest;
    let networkRequest;
    let storageRequest;
    let settingsRequest;
    let logRequest;
    let lifecycleRequest;
    if (structured) {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 80) {
        return { ok: false, requestId: '', error: { code: 'invalid_request', message: 'A valid request ID is required.' } };
      }
      if (message.apiVersion !== record.metadata.apiVersion) {
        return respond(false, null, 'unsupported_api_version', 'The Activity API version does not match its package metadata.');
      }
      if (message.operation === 'presence.report') {
        operation = 'report';
        reportValue = message.payload?.report;
      } else if (message.operation === 'presence.clear') {
        operation = 'clear';
      } else if (message.operation === 'page.execute') {
        operation = 'page.execute';
        pageRequest = message.payload;
      } else if (message.operation === 'net.fetch') {
        operation = 'net.fetch';
        networkRequest = message.payload;
      } else if (['storage.get', 'storage.set', 'storage.remove', 'storage.clear'].includes(message.operation)) {
        operation = message.operation;
        storageRequest = message.payload;
      } else if (['settings.get', 'settings.getAll'].includes(message.operation)) {
        operation = message.operation;
        settingsRequest = message.payload;
      } else if (message.operation === 'log.write') {
        operation = message.operation;
        logRequest = message.payload;
      } else if (['lifecycle.upgradeComplete', 'lifecycle.upgradeError'].includes(message.operation)) {
        operation = message.operation;
        lifecycleRequest = message.payload;
      } else {
        return respond(false, null, 'unsupported_operation', 'This Activity runtime operation is not supported.');
      }
    } else if (message?.type === 'CHUDPRESENCE_ACTIVITY_CLEAR') {
      operation = 'clear';
    } else if (message?.type === 'CHUDPRESENCE_ACTIVITY_REPORT') {
      operation = 'report';
      reportValue = message.report;
    } else {
      return false;
    }

    if (!this.allowReport(id, tabId)) {
      return respond(false, null, 'rate_limited', 'The Activity has sent too many requests.');
    }

    if (operation === 'page.execute') {
      if (isProtectedPage(sender.url || '')) {
        return respond(false, null, 'protected_page', 'Page execution is unavailable on protected pages.');
      }
      if (typeof sender.documentId !== 'string' || !sender.documentId || !Number.isInteger(sender.frameId)) {
        return respond(false, null, 'unsupported_context', 'This browser did not provide a document-bound execution context.');
      }
      if (typeof pageRequest?.source !== 'string' || !pageRequest.source || pageRequest.source.length > MAX_PAGE_EXECUTE_SOURCE_LENGTH) {
        return respond(false, null, 'invalid_page_request', 'The page function is missing or exceeds the 16 KB limit.');
      }
      if (typeof pageRequest.argsJson !== 'string' || pageRequest.argsJson.length > MAX_PAGE_EXECUTE_ARGUMENTS_LENGTH) {
        return respond(false, null, 'invalid_page_request', 'The page arguments are missing or exceed the 16 KB limit.');
      }
      let pageArguments;
      try {
        pageArguments = JSON.parse(pageRequest.argsJson);
      } catch {
        return respond(false, null, 'invalid_page_request', 'The page arguments must be valid JSON.');
      }
      if (!Array.isArray(pageArguments)) {
        return respond(false, null, 'invalid_page_request', 'The page arguments must be a JSON array.');
      }
      if (typeof this.api.userScripts?.execute !== 'function') {
        return respond(false, null, 'unsupported_operation', 'This browser does not support page-context execution.');
      }
      let executionResults;
      try {
        executionResults = await this.api.userScripts.execute({
          js: [{ code: pageExecutionCode(pageRequest.source, pageRequest.argsJson) }],
          target: { tabId, documentIds: [sender.documentId] },
          world: 'MAIN',
        });
      } catch (error) {
        return respond(false, null, 'page_execution_failed', String(error?.message || 'Page execution failed').slice(0, 500), error?.name || 'Error');
      }
      const injection = Array.isArray(executionResults) ? executionResults[0] : null;
      if (!injection) return respond(false, null, 'page_execution_failed', 'The browser did not return an execution result.');
      if (injection.documentId && injection.documentId !== sender.documentId) {
        return respond(false, null, 'stale_document', 'The page navigated while execution was pending.');
      }
      if (typeof injection.error === 'string') {
        return respond(false, null, 'page_execution_failed', injection.error.slice(0, 500), 'InjectionError');
      }
      if (typeof injection.result !== 'string' || injection.result.length > MAX_PAGE_EXECUTE_RESULT_LENGTH + 1024) {
        return respond(false, null, 'invalid_page_result', 'The page returned a missing or oversized result.');
      }
      let pageResult;
      try {
        pageResult = JSON.parse(injection.result);
      } catch {
        return respond(false, null, 'invalid_page_result', 'The page returned a result that was not valid JSON.');
      }
      if (pageResult?.ok === true && Object.hasOwn(pageResult, 'value')) {
        return respond(true, { value: pageResult.value });
      }
      if (pageResult?.ok === false && pageResult.error && typeof pageResult.error.message === 'string') {
        return respond(false, null,
          typeof pageResult.error.code === 'string' ? pageResult.error.code : 'page_execution_error',
          pageResult.error.message.slice(0, 500),
          typeof pageResult.error.name === 'string' ? pageResult.error.name.slice(0, 80) : 'Error',
        );
      }
      return respond(false, null, 'invalid_page_result', 'The page returned an invalid execution envelope.');
    }

    if (structured && (!sender.documentId || typeof sender.documentId !== 'string')) {
      return respond(false, null, 'unsupported_context', 'This browser did not provide a document-bound Activity context.');
    }

    if (operation === 'lifecycle.upgradeComplete' || operation === 'lifecycle.upgradeError') {
      try {
        const result = await this.completeActivityUpgrade(id, record, sender, operation, lifecycleRequest);
        return respond(true, result);
      } catch (error) {
        return respond(false, null, error.code || 'upgrade_state_error', error.message || 'Could not record Activity upgrade state.');
      }
    }

    if (operation === 'net.fetch') {
      const result = await this.executeNetworkRequest(id, record, sender, requestId, networkRequest);
      if (result.ok) return respond(true, result.data);
      return respond(false, null, result.error.code, result.error.message, result.error.name);
    }

    if (operation.startsWith('storage.')) {
      try {
        const data = await this.executeActivityStorage(id, operation, storageRequest);
        return respond(true, data);
      } catch (error) {
        return respond(false, null,
          typeof error?.code === 'string' ? error.code : 'storage_error',
          String(error?.message || 'Activity storage failed').slice(0, 300),
          error?.name || 'Error',
        );
      }
    }

    if (operation === 'settings.getAll') {
      return respond(true, { value: this.settingsFor(id) });
    }
    if (operation === 'settings.get') {
      const settingId = settingsRequest?.id;
      if (typeof settingId !== 'string' || !(record.metadata.settings || []).some((setting) => setting.id === settingId)) {
        return respond(false, null, 'invalid_setting_id', 'This Activity does not declare that setting.', 'TypeError');
      }
      return respond(true, { value: this.settingsFor(id)[settingId] });
    }

    if (operation === 'log.write') {
      try {
        return respond(true, this.executeActivityLog(id, record, sender, logRequest));
      } catch (error) {
        return respond(false, null,
          typeof error?.code === 'string' ? error.code : 'log_error',
          String(error?.message || 'Activity log could not be recorded').slice(0, 300),
          error?.name || 'Error',
        );
      }
    }

    if (operation === 'clear') {
      const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
      const tabs = this.lastSeen.get(id);
      const frames = tabs?.get(tabId);
      const seen = frames?.get(frameId);
      const messageDocumentId = sender.documentId || null;
      const isLateClear = !seen ||
        seen.retiredDocumentIds?.has(messageDocumentId) ||
        (seen.documentId && messageDocumentId && seen.documentId !== messageDocumentId) ||
        (!seen.documentId && !messageDocumentId && seen.senderUrl && sender.url && seen.senderUrl !== sender.url);
      if (isLateClear) return respond(true, { cleared: false, stale: true });
      this.recordActivityClear(id, sender);
      frames.delete(frameId);
      if (!frames.size) tabs.delete(tabId);
      if (!tabs.size) this.lastSeen.delete(id);
      await this.onClear(id, tabId, messageDocumentId, frameId);
      return respond(true, { cleared: true, stale: false });
    }

    let report;
    try {
      report = normalizeActivityReport(reportValue, record.metadata.apiVersion);
    } catch (error) {
      return respond(false, null, 'invalid_report', String(error.message || 'Activity report was invalid').slice(0, 240));
    }
    const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
    if (!this.lastSeen.has(id)) this.lastSeen.set(id, new Map());
    const tabs = this.lastSeen.get(id);
    if (!tabs.has(tabId)) tabs.set(tabId, new Map());
    const frames = tabs.get(tabId);
    const prior = frames.get(frameId);
    const retiredDocumentIds = new Set(prior?.retiredDocumentIds || []);
    if (retiredDocumentIds.has(sender.documentId)) {
      return respond(false, null, 'stale_document', 'This Activity document has already been replaced.');
    }
    const replacedTopDocument = frameId === 0 && prior?.documentId && prior.documentId !== sender.documentId;
    const staleChildren = replacedTopDocument
      ? [...frames.entries()].filter(([childFrameId, context]) => childFrameId !== 0 && context.active !== false && context.documentId)
      : [];
    for (const [childFrameId, childContext] of staleChildren) {
      const childRetiredDocumentIds = new Set(childContext.retiredDocumentIds || []);
      childRetiredDocumentIds.add(childContext.documentId);
      while (childRetiredDocumentIds.size > MAX_RETIRED_DOCUMENTS_PER_FRAME) {
        childRetiredDocumentIds.delete(childRetiredDocumentIds.values().next().value);
      }
      frames.set(childFrameId, {
        ...childContext,
        documentId: null,
        lastDocumentId: childContext.documentId,
        active: false,
        lastSeen: Date.now(),
        retiredDocumentIds: childRetiredDocumentIds,
      });
    }
    let replacedDocumentId = null;
    if (prior?.documentId && prior.documentId !== sender.documentId) {
      if (retiredDocumentIds.has(sender.documentId)) {
        return respond(false, null, 'stale_document', 'This Activity document has already been replaced.');
      }
      replacedDocumentId = prior.documentId;
      retiredDocumentIds.add(prior.documentId);
      while (retiredDocumentIds.size > MAX_RETIRED_DOCUMENTS_PER_FRAME) {
        retiredDocumentIds.delete(retiredDocumentIds.values().next().value);
      }
    }
    if (retiredDocumentIds.has(sender.documentId)) {
      return respond(false, null, 'stale_document', 'This Activity document has already been replaced.');
    }
    const track = {
      ...report,
      source: 'activity',
      activityId: id,
      activityName: record.metadata.name,
      activityCategory: record.metadata.category || 'other',
      activityVersion: record.metadata.version,
    };
    const diagnostics = this.activityDiagnostics.get(id) || {};
    diagnostics.rawReport = sanitizeDiagnosticValue(reportValue);
    diagnostics.normalizedReport = sanitizeDiagnosticValue(track);
    diagnostics.lastReport = {
      timestamp: new Date().toISOString(),
      tabId,
      frameId,
      documentId: sender.documentId || null,
      senderUrl: safeDiagnosticUrl(sender.url || ''),
    };
    this.activityDiagnostics.set(id, diagnostics);
    frames.set(frameId, {
      tabId,
      frameId,
      parentFrameId: Number.isInteger(sender.parentFrameId) ? sender.parentFrameId : null,
      documentId: sender.documentId || null,
      senderUrl: sender.url || '',
      lastSeen: Date.now(),
      active: true,
      track,
      retiredDocumentIds,
    });
    for (const [childFrameId, childContext] of staleChildren) {
      await this.onClear(id, tabId, childContext.documentId, childFrameId);
    }
    if (replacedDocumentId) {
      await this.onClear(id, tabId, replacedDocumentId, frameId);
      if (frames.get(frameId)?.documentId !== sender.documentId) {
        return respond(false, null, 'stale_document', 'This Activity document has already been replaced.');
      }
    }
    await this.onReport({
      activityId: id,
      documentId: sender.documentId || null,
      frameId,
      parentFrameId: Number.isInteger(sender.parentFrameId) ? sender.parentFrameId : null,
      senderUrl: sender.url || '',
      tabId,
      track,
    });
    return respond(true, { accepted: true });
  }

  async notifyPendingUpgrade(id, record, port, sender) {
    const transition = record?.pendingUpgrade;
    if (!transition || typeof port?.postMessage !== 'function' ||
        typeof sender?.tab?.id !== 'number' || typeof sender?.documentId !== 'string' ||
        transition.toVersion !== record.metadata.version) return false;
    const key = `${id}:${transition.fromVersion}->${transition.toVersion}`;
    if (this.pendingUpgradeNotifications.has(key)) return false;
    this.pendingUpgradeNotifications.add(key);
    try {
      port.postMessage({
        type: 'CHUDPRESENCE_ACTIVITY_UPGRADE',
        activityId: id,
        activityVersion: record.metadata.version,
        fromVersion: transition.fromVersion,
        toVersion: transition.toVersion,
      });
      this.upgradeNotificationPorts.set(port, key);
      return true;
    } catch {
      this.pendingUpgradeNotifications.delete(key);
      return false;
    }
  }

  completeActivityUpgrade(id, record, sender, operation, request) {
    return this.serialize(async () => {
      const records = await this.load();
      const current = records[id];
      const transition = current?.pendingUpgrade;
      if (!transition) return { completed: false, pending: false };
      if (request?.fromVersion !== transition.fromVersion || request?.toVersion !== transition.toVersion ||
          request?.toVersion !== current.metadata.version || record.metadata.version !== current.metadata.version) {
        const error = new TypeError('Activity upgrade transition does not match the installed version.');
        error.code = 'invalid_upgrade_transition';
        throw error;
      }
      const key = `${id}:${transition.fromVersion}->${transition.toVersion}`;
      if (operation === 'lifecycle.upgradeError') {
        this.pendingUpgradeNotifications.delete(key);
        const details = `Activity migration ${transition.fromVersion} → ${transition.toVersion} failed: ${String(request?.message || 'Migration failed').slice(0, 300)}`;
        this.recordActivityError(id, sender, 'upgrade_migration_failed', details);
        const previous = this.activityDiagnostics.get(id) || {};
        previous.lastUpgrade = {
          timestamp: new Date().toISOString(),
          fromVersion: transition.fromVersion,
          toVersion: transition.toVersion,
          status: 'failed',
          name: String(request?.name || 'Error').slice(0, 80),
        };
        this.activityDiagnostics.set(id, previous);
        return { completed: false, pending: true };
      }
      delete current.pendingUpgrade;
      try {
        await this.save();
      } catch (error) {
        current.pendingUpgrade = transition;
        throw error;
      }
      this.pendingUpgradeNotifications.delete(key);
      const previous = this.activityDiagnostics.get(id) || {};
      previous.lastUpgrade = {
        timestamp: new Date().toISOString(),
        fromVersion: transition.fromVersion,
        toVersion: transition.toVersion,
        status: 'completed',
        tabId: sender?.tab?.id ?? null,
        frameId: Number.isInteger(sender?.frameId) ? sender.frameId : null,
        documentId: sender?.documentId || null,
      };
      this.activityDiagnostics.set(id, previous);
      return { completed: true, pending: false };
    });
  }

  async invalidateTab(tabId) {
    if (!Number.isInteger(tabId)) return 0;
    const callbacks = [];
    let invalidated = 0;
    for (const [id, tabs] of this.lastSeen) {
      const frames = tabs.get(tabId);
      if (!frames) continue;
      for (const [frameId, context] of frames) {
        if (context.active === false) continue;
        const retiredDocumentIds = new Set(context.retiredDocumentIds || []);
        if (context.documentId) retiredDocumentIds.add(context.documentId);
        while (retiredDocumentIds.size > MAX_RETIRED_DOCUMENTS_PER_FRAME) {
          retiredDocumentIds.delete(retiredDocumentIds.values().next().value);
        }
        frames.set(frameId, {
          ...context,
          documentId: null,
          lastDocumentId: context.documentId,
          active: false,
          lastSeen: Date.now(),
          retiredDocumentIds,
        });
        callbacks.push([id, context.documentId, frameId]);
        invalidated += 1;
      }
    }
    await Promise.all(callbacks.map(([id, documentId, frameId]) =>
      this.onClear(id, tabId, documentId, frameId),
    ));
    return invalidated;
  }

  async pruneStale(now = Date.now()) {
    let cleared = 0;
    for (const [id, tabs] of this.lastSeen) {
      for (const [tabId, frames] of tabs) {
        for (const [frameId, seen] of frames) {
          if (now - seen.lastSeen <= STATUS_TTL_MS) continue;
          frames.delete(frameId);
          if (seen.active !== false) await this.onClear(id, tabId, seen.documentId, frameId);
          cleared += 1;
        }
        if (!frames.size) tabs.delete(tabId);
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
    let grantedOrigins = [];
    try {
      const permissionState = await this.api.permissions?.getAll?.();
      if (Array.isArray(permissionState?.origins)) grantedOrigins = [...permissionState.origins];
    } catch {
      grantedOrigins = [];
    }
    return {
      apiVersion: LATEST_ACTIVITY_API_VERSION,
      userScriptsAvailable: Boolean(this.api.userScripts),
      userScriptsPermission,
      installed: statuses,
      grantedOrigins,
      count: Object.keys(records).length,
    };
  }
}
