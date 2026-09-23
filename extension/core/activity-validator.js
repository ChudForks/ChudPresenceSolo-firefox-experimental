import { validateActivitySettingDefinitions } from './activity-settings.js';
import {
  ACTIVITY_API_VERSION,
  ACTIVITY_ID_PATTERN,
  ACTIVITY_KIND_VALUES,
  ACTIVITY_METADATA_FIELDS,
  ACTIVITY_SEMVER_PATTERN,
  SUPPORTED_ACTIVITY_API_VERSIONS as CONTRACT_SUPPORTED_ACTIVITY_API_VERSIONS,
  MAX_ACTIVITY_ICON_BYTES,
  MAX_ACTIVITY_METADATA_BYTES,
  MAX_ACTIVITY_REPORT_BYTES,
  MAX_ACTIVITY_SOURCE_BYTES,
  MAX_ACTIVITY_TEXT_LENGTH,
  MAX_ACTIVITY_URL_LENGTH,
  PRESENCE_KIND_VALUES,
  REPORT_ARTWORK_FIELDS as CONTRACT_REPORT_ARTWORK_FIELDS,
  REPORT_DISPLAY_FIELDS as CONTRACT_REPORT_DISPLAY_FIELDS,
  REPORT_MEDIA_FIELDS as CONTRACT_REPORT_MEDIA_FIELDS,
  REPORT_PLAYBACK_FIELDS as CONTRACT_REPORT_PLAYBACK_FIELDS,
  REPORT_PLAYBACK_STATE_VALUES,
  REPORT_STATUS_DISPLAY_VALUES,
  REPORT_VISIBILITY_VALUES,
} from './activity-contract.generated.js';

export const LATEST_ACTIVITY_API_VERSION = ACTIVITY_API_VERSION;
export { ACTIVITY_API_VERSION, MAX_ACTIVITY_ICON_BYTES, MAX_ACTIVITY_REPORT_BYTES, MAX_ACTIVITY_SOURCE_BYTES };
export const SUPPORTED_ACTIVITY_API_VERSIONS = CONTRACT_SUPPORTED_ACTIVITY_API_VERSIONS;
// Keep the original export for callers that need to generate current metadata.
const ACTIVITY_ID = new RegExp(ACTIVITY_ID_PATTERN);
const ACTIVITY_KINDS = new Set(ACTIVITY_KIND_VALUES);
const PRESENCE_KINDS = new Set(PRESENCE_KIND_VALUES);

export function isSupportedActivityApiVersion(version) {
  return SUPPORTED_ACTIVITY_API_VERSIONS.includes(version);
}
const REPORT_TEXT_LIMIT = MAX_ACTIVITY_TEXT_LENGTH;
const REPORT_URL_LIMIT = MAX_ACTIVITY_URL_LENGTH;
const REPORT_MEDIA_FIELDS = new Set(CONTRACT_REPORT_MEDIA_FIELDS);
const REPORT_PLAYBACK_FIELDS = new Set(CONTRACT_REPORT_PLAYBACK_FIELDS);
const REPORT_DISPLAY_FIELDS = new Set(CONTRACT_REPORT_DISPLAY_FIELDS);
const REPORT_ARTWORK_FIELDS = new Set(CONTRACT_REPORT_ARTWORK_FIELDS);
const REPORT_VISIBILITY = new Set(REPORT_VISIBILITY_VALUES);
const REPORT_PLAYBACK_STATES = new Set(REPORT_PLAYBACK_STATE_VALUES);
const REPORT_STATUS_DISPLAY = new Set(REPORT_STATUS_DISPLAY_VALUES);
const PROTECTED_NETWORK_DOMAINS = ['discord.com', 'discordapp.com', 'discordapp.net'];
const METADATA_FIELDS = new Set(ACTIVITY_METADATA_FIELDS);
const SEMVER = new RegExp(ACTIVITY_SEMVER_PATTERN);

function fail(message) {
  throw new TypeError(message);
}

export function validateActivityIcon(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') fail('Activity icon must be a PNG data URL.');
  if (value.length > Math.ceil(MAX_ACTIVITY_ICON_BYTES * 4 / 3) + 64) {
    fail(`Activity icon must be no larger than ${MAX_ACTIVITY_ICON_BYTES} bytes.`);
  }
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail('Activity icon must be a base64 PNG data URL.');
  let binary;
  try {
    binary = atob(match[1]);
  } catch {
    fail('Activity icon contains invalid base64 data.');
  }
  if (!binary.length || binary.length > MAX_ACTIVITY_ICON_BYTES) {
    fail(`Activity icon must be between 1 byte and ${MAX_ACTIVITY_ICON_BYTES} bytes.`);
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => binary.charCodeAt(index) !== byte)) {
    fail('Activity icon must be a valid PNG image.');
  }
  return match[1];
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanHttpsUrl(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > REPORT_URL_LIMIT) {
    fail(`${field} must be a string no longer than ${REPORT_URL_LIMIT} characters.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${field} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    fail(`${field} must be a valid HTTPS URL.`);
  }
  return parsed.toString();
}

function validateStringList(value, field, { maxItems = 32, maxLength = 80, pattern = null } = {}) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maxItems || new Set(value).size !== value.length ||
      !value.every((item) => typeof item === 'string' && item.trim() === item && item.length > 0 &&
        item.length <= maxLength && (!pattern || pattern.test(item)))) {
    fail(`Activity ${field} must contain up to ${maxItems} unique strings no longer than ${maxLength} characters.`);
  }
}

function validHost(host) {
  if (host === '*') return false;
  const normalized = host.startsWith('*.') ? host.slice(2) : host;
  if (!normalized || normalized.length > 253 || normalized.includes('*')) return false;
  return normalized.split('.').every((label) =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

export function isActivityId(value) {
  return typeof value === 'string' && ACTIVITY_ID.test(value);
}

export function isSemanticVersion(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(SEMVER);
  if (!match) return false;
  return !match[4] || match[4].split('.').every((identifier) =>
    !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'),
  );
}

export function validateMatchPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256) return false;
  const match = pattern.match(/^(https):\/\/([^/]+)\/(.*)$/i);
  if (!match || !validHost(match[2])) return false;
  const path = match[3];
  if (!path || path.includes('\\') || path.includes('#')) return false;
  return !/[?]/.test(path) && /^[-a-z0-9_.*%!$&'()+,;=:@/]*$/i.test(path);
}

function protectedNetworkPattern(pattern) {
  const match = pattern.match(/^https:\/\/([^/]+)\//i);
  if (!match) return false;
  const host = match[1].toLowerCase().replace(/^\*\./, '');
  return PROTECTED_NETWORK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function validateActivityMetadata(metadata) {
  if (!isPlainObject(metadata)) fail('Activity metadata must be a JSON object.');
  for (const key of Object.keys(metadata)) {
    if (!METADATA_FIELDS.has(key)) fail(`Activity metadata contains unsupported field ${key}.`);
  }
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > MAX_ACTIVITY_METADATA_BYTES) {
    fail(`Activity metadata exceeds the ${Math.round(MAX_ACTIVITY_METADATA_BYTES / 1024)} KB size limit.`);
  }
  const required = ['id', 'name', 'description', 'version', 'apiVersion', 'matches', 'entry'];
  for (const key of required) {
    if (!(key in metadata)) fail(`Activity metadata is missing ${key}.`);
  }
  if (!isActivityId(metadata.id)) fail('Activity ID must match ^[a-z0-9][a-z0-9-]{1,63}$.');
  if (typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 80) {
    fail('Activity name must be a non-empty string up to 80 characters.');
  }
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 500) {
    fail('Activity description must be a non-empty string up to 500 characters.');
  }
  if (!isSemanticVersion(metadata.version)) {
    fail('Activity version must use semantic version format (for example, 1.0.0).');
  }
  if (!isSupportedActivityApiVersion(metadata.apiVersion)) {
    fail(`Activity API version ${metadata.apiVersion} is not supported.`);
  }
  if (metadata.minExtensionVersion !== undefined && !isSemanticVersion(metadata.minExtensionVersion)) {
    fail('Activity minExtensionVersion must use semantic version format.');
  }
  if (!Array.isArray(metadata.matches) || metadata.matches.length < 1 || metadata.matches.length > 32) {
    fail('Activity matches must contain between 1 and 32 HTTPS site patterns.');
  }
  if (new Set(metadata.matches).size !== metadata.matches.length || !metadata.matches.every(validateMatchPattern)) {
    fail('Activity contains an invalid or duplicate HTTPS site match pattern.');
  }
  const network = metadata.network === undefined ? [] : metadata.network;
  if (!Array.isArray(network) || network.length > 32 || new Set(network).size !== network.length ||
      !network.every(validateMatchPattern)) {
    fail('Activity network must contain at most 32 unique HTTPS site patterns.');
  }
  if (network.some(protectedNetworkPattern)) {
    fail('Activities cannot declare Discord network endpoints.');
  }
  if (typeof metadata.entry !== 'string' || metadata.entry !== 'activity.js') {
    fail('Activity entry must be the package-local file activity.js.');
  }
  if (metadata.icon !== undefined && (typeof metadata.icon !== 'string' || metadata.icon !== 'icon.png')) {
    fail('Activity icon must be the package-local file icon.png.');
  }
  if (metadata.category !== undefined &&
      (typeof metadata.category !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(metadata.category))) {
    fail('Activity category must be a short lowercase identifier.');
  }
  if (metadata.defaultMediaKind !== undefined && !ACTIVITY_KINDS.has(metadata.defaultMediaKind)) {
    fail('Activity defaultMediaKind must be a supported media kind.');
  }
  validateStringList(metadata.aliases, 'aliases');
  validateStringList(metadata.tags, 'tags', { maxLength: 32, pattern: /^[a-z0-9][a-z0-9-]{0,31}$/ });
  const excludeMatches = metadata.excludeMatches === undefined ? [] : metadata.excludeMatches;
  if (!Array.isArray(excludeMatches) || excludeMatches.length > 32 || new Set(excludeMatches).size !== excludeMatches.length ||
      !excludeMatches.every(validateMatchPattern)) {
    fail('Activity excludeMatches must contain at most 32 unique HTTPS URL patterns.');
  }
  if (metadata.contributors !== undefined &&
      (!Array.isArray(metadata.contributors) || metadata.contributors.length > 16 || metadata.contributors.some((person) =>
        !isPlainObject(person) || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 80 ||
        Object.keys(person).some((key) => key !== 'name' && key !== 'url') ||
        (person.url !== undefined && typeof cleanHttpsUrl(person.url, 'contributor url') !== 'string')))) {
    fail('Activity contributors must contain up to 16 people with names and optional HTTPS URLs.');
  }
  if (metadata.author !== undefined &&
      (!isPlainObject(metadata.author) || typeof metadata.author.name !== 'string' ||
       !metadata.author.name.trim() || metadata.author.name.length > 80 ||
       Object.keys(metadata.author).some((key) => key !== 'name' && key !== 'url'))) {
    fail('Activity author must contain a name and may contain only a profile URL.');
  }
  if (metadata.author?.url !== undefined) cleanHttpsUrl(metadata.author.url, 'url');
  for (const field of ['repository', 'homepage', 'serviceUrl']) {
    if (metadata[field] !== undefined) cleanHttpsUrl(metadata[field], 'url');
  }
  if (metadata.presence !== undefined &&
      (!isPlainObject(metadata.presence) || Object.keys(metadata.presence).some((key) => key !== 'kind') ||
       (metadata.presence.kind !== undefined && !PRESENCE_KINDS.has(metadata.presence.kind)))) {
    fail('Activity presence may contain only a supported kind.');
  }
  if (metadata.executionWorld !== undefined && metadata.executionWorld !== 'USER_SCRIPT') {
    fail('Only the isolated USER_SCRIPT execution world is currently supported.');
  }
  if (metadata.frames !== undefined && !['top', 'all'].includes(metadata.frames)) {
    fail('Activity frames must be top or all.');
  }
  const settings = validateActivitySettingDefinitions(metadata.settings ?? []);
  return {
    ...metadata,
    id: metadata.id,
    name: metadata.name.trim(),
    description: metadata.description.trim(),
    matches: [...metadata.matches],
    network: [...network],
    settings,
    executionWorld: 'USER_SCRIPT',
    frames: metadata.frames || 'top',
  };
}

export function validateActivitySource(source) {
  if (typeof source !== 'string' || !source.trim()) fail('Activity source must be a non-empty JavaScript string.');
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > MAX_ACTIVITY_SOURCE_BYTES) {
    fail(`Activity source exceeds the ${MAX_ACTIVITY_SOURCE_BYTES / 1024} KB size limit.`);
  }
  return source;
}

function cleanText(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${field} must be a non-empty string up to ${REPORT_TEXT_LIMIT} characters.`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > REPORT_TEXT_LIMIT) {
    fail(`${field} must be a string up to ${REPORT_TEXT_LIMIT} characters.`);
  }
  const normalized = value.trim();
  if (required && !normalized) fail(`${field} must be a non-empty string up to ${REPORT_TEXT_LIMIT} characters.`);
  return normalized;
}

function normalizeReportTextObject(value, allowed, path) {
  if (!isPlainObject(value)) fail(`${path} must be a JSON object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unsupported field ${key}.`);
  }
}

function normalizeMedia(value) {
  normalizeReportTextObject(value, REPORT_MEDIA_FIELDS, 'media');
  const media = {};
  for (const field of REPORT_MEDIA_FIELDS) {
    if (field === 'season' || field === 'episode') continue;
    const cleaned = cleanText(value[field], `media.${field}`, { required: field === 'title' });
    if (cleaned !== undefined) media[field] = cleaned;
  }
  for (const field of ['season', 'episode']) {
    if (value[field] === undefined || value[field] === null) continue;
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 10_000) {
      fail(`media.${field} must be an integer between 0 and 10000.`);
    }
    media[field] = value[field];
  }
  return media;
}

function normalizePlayback(value = {}) {
  if (value === undefined) value = {};
  normalizeReportTextObject(value, REPORT_PLAYBACK_FIELDS, 'playback');
  const playback = { state: 'playing', position: 0, duration: 0, live: false, rate: 1 };
  if (value.state !== undefined) {
    if (typeof value.state !== 'string' || !REPORT_PLAYBACK_STATES.has(value.state)) {
      fail('playback.state must be playing, paused, or stopped.');
    }
    playback.state = value.state;
  }
  if (value.live !== undefined) {
    if (typeof value.live !== 'boolean') fail('playback.live must be a boolean.');
    playback.live = value.live;
  }
  for (const field of ['position', 'duration']) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0 || value[field] > 31_536_000) {
      fail(`playback.${field} must be a finite number between 0 and one year in seconds.`);
    }
    playback[field] = value[field];
  }
  if (value.rate !== undefined) {
    if (typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate < 0 || value.rate > 16) {
      fail('playback.rate must be a finite number between 0 and 16.');
    }
    playback.rate = value.rate;
  }
  return playback;
}

function defaultDisplay(kind, media) {
  switch (kind) {
    case 'song': return { details: media.title, state: media.artist || '' };
    case 'episode': return { details: media.series || media.title, state: media.title };
    case 'stream': return { details: media.title, state: media.creator || media.channel || '' };
    case 'game': return { details: media.game || media.title, state: media.category || '' };
    case 'video': return { details: media.title, state: media.creator || media.channel || '' };
    case 'movie': return { details: media.title, state: '' };
    default: return { details: media.title, state: media.subtitle || '' };
  }
}

function normalizeDisplay(value, kind, media) {
  if (value === undefined) value = {};
  normalizeReportTextObject(value, REPORT_DISPLAY_FIELDS, 'display');
  const display = defaultDisplay(kind, media);
  for (const field of ['details', 'state']) {
    if (value[field] === undefined) continue;
    const cleaned = cleanText(value[field], `display.${field}`) || '';
    display[field] = cleaned;
  }
  display.statusDisplay = value.statusDisplay === undefined ? 'details' : value.statusDisplay;
  if (typeof display.statusDisplay !== 'string' || !REPORT_STATUS_DISPLAY.has(display.statusDisplay)) {
    fail('display.statusDisplay must be name, details, or state.');
  }
  return display;
}

function normalizeArtwork(value) {
  if (value === undefined) value = {};
  normalizeReportTextObject(value, REPORT_ARTWORK_FIELDS, 'artwork');
  const artwork = {};
  for (const field of ['large', 'small']) {
    const url = cleanHttpsUrl(value[field], `artwork.${field}`);
    if (url) artwork[field] = url;
  }
  for (const field of ['largeText', 'smallText']) {
    const cleaned = cleanText(value[field], `artwork.${field}`);
    if (cleaned !== undefined) artwork[field] = cleaned;
  }
  return artwork;
}

function normalizeButtons(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) fail('buttons must contain at most two items.');
  return value.map((button, index) => {
    if (!isPlainObject(button) || Object.keys(button).some((key) => !['label', 'url'].includes(key))) {
      fail(`button ${index + 1} must contain only label and url.`);
    }
    const label = cleanText(button.label, `button ${index + 1} label`, { required: true });
    if (label.length > 32) fail(`button ${index + 1} label must be 1 to 32 characters.`);
    const url = cleanHttpsUrl(button.url, `button ${index + 1} url`);
    if (!url) fail(`button ${index + 1} must have a valid HTTPS URL.`);
    return { label, url };
  });
}

function normalizeActivityReportV1(report) {
  if (!isPlainObject(report)) fail('Activity report must be a JSON object.');
  const allowed = new Set(['kind', 'media', 'playback', 'display', 'artwork', 'buttons', 'visibility']);
  for (const key of Object.keys(report)) {
    if (!allowed.has(key)) fail(`Activity report contains unsupported field ${key}.`);
  }
  if (typeof report.kind !== 'string' || !ACTIVITY_KINDS.has(report.kind)) {
    fail('kind must be one of the supported generic Activity kinds.');
  }
  const media = normalizeMedia(report.media);
  const normalized = {
    kind: report.kind,
    media,
    playback: normalizePlayback(report.playback),
    display: normalizeDisplay(report.display, report.kind, media),
    artwork: normalizeArtwork(report.artwork),
    buttons: normalizeButtons(report.buttons),
    visibility: report.visibility === undefined ? 'normal' : report.visibility,
  };
  if (typeof normalized.visibility !== 'string' || !REPORT_VISIBILITY.has(normalized.visibility)) {
    fail('visibility must be normal, idle, private, or ad.');
  }
  const encoded = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (encoded > MAX_ACTIVITY_REPORT_BYTES) fail('Activity report exceeds the 16 KB size limit.');
  return normalized;
}

const REPORT_NORMALIZERS = new Map([
  [1, normalizeActivityReportV1],
]);

export function normalizeActivityReport(report, apiVersion = LATEST_ACTIVITY_API_VERSION) {
  if (!isSupportedActivityApiVersion(apiVersion)) {
    fail(`Activity API version ${apiVersion} is not supported.`);
  }
  const normalize = REPORT_NORMALIZERS.get(apiVersion);
  if (!normalize) fail(`Activity API version ${apiVersion} has no report normalizer.`);
  return normalize(report);
}
