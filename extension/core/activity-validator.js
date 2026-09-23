export const LATEST_ACTIVITY_API_VERSION = 1;
export const SUPPORTED_ACTIVITY_API_VERSIONS = Object.freeze([1]);
// Keep the original export for callers that need to generate current metadata.
export const ACTIVITY_API_VERSION = LATEST_ACTIVITY_API_VERSION;
export const MAX_ACTIVITY_SOURCE_BYTES = 512 * 1024;
export const MAX_ACTIVITY_REPORT_BYTES = 16 * 1024;
export const MAX_ACTIVITY_ICON_BYTES = 256 * 1024;

const ACTIVITY_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ACTIVITY_KINDS = new Set([
  'video', 'movie', 'episode', 'song', 'stream', 'game', 'generic',
]);
const PRESENCE_KINDS = new Set(['music', 'video', 'streaming', 'generic']);

export function isSupportedActivityApiVersion(version) {
  return SUPPORTED_ACTIVITY_API_VERSIONS.includes(version);
}
const REPORT_STRING_LIMITS = Object.freeze({
  title: 256,
  artist: 256,
  album: 256,
  details: 256,
  state: 256,
  artwork: 2048,
  url: 2048,
});
const METADATA_FIELDS = new Set([
  'id', 'name', 'description', 'version', 'apiVersion', 'author', 'category',
  'matches', 'entry', 'icon', 'executionWorld', 'repository', 'homepage', 'presence',
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
  if (typeof value !== 'string' || value.length > REPORT_STRING_LIMITS[field]) {
    fail(`${field} must be a string no longer than ${REPORT_STRING_LIMITS[field]} characters.`);
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

export function validateActivityMetadata(metadata) {
  if (!isPlainObject(metadata)) fail('Activity metadata must be a JSON object.');
  for (const key of Object.keys(metadata)) {
    if (!METADATA_FIELDS.has(key)) fail(`Activity metadata contains unsupported field ${key}.`);
  }
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 64 * 1024) {
    fail('Activity metadata exceeds the 64 KB size limit.');
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
  if (!Array.isArray(metadata.matches) || metadata.matches.length < 1 || metadata.matches.length > 32) {
    fail('Activity matches must contain between 1 and 32 HTTPS site patterns.');
  }
  if (new Set(metadata.matches).size !== metadata.matches.length || !metadata.matches.every(validateMatchPattern)) {
    fail('Activity contains an invalid or duplicate HTTPS site match pattern.');
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
  if (metadata.author !== undefined &&
      (!isPlainObject(metadata.author) || typeof metadata.author.name !== 'string' ||
       !metadata.author.name.trim() || metadata.author.name.length > 80 ||
       Object.keys(metadata.author).some((key) => key !== 'name' && key !== 'url'))) {
    fail('Activity author must contain a name and may contain only a profile URL.');
  }
  if (metadata.author?.url !== undefined) cleanHttpsUrl(metadata.author.url, 'url');
  for (const field of ['repository', 'homepage']) {
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
  return {
    ...metadata,
    id: metadata.id,
    name: metadata.name.trim(),
    description: metadata.description.trim(),
    matches: [...metadata.matches],
    executionWorld: 'USER_SCRIPT',
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

function normalizeActivityReportV1(report) {
  if (!isPlainObject(report)) fail('Activity report must be a JSON object.');
  const allowed = new Set([
    ...Object.keys(REPORT_STRING_LIMITS), 'playing', 'live', 'position', 'duration', 'kind', 'buttons',
  ]);
  for (const key of Object.keys(report)) {
    if (!allowed.has(key)) fail(`Activity report contains unsupported field ${key}.`);
  }

  const title = report.title;
  if (typeof title !== 'string' || !title.trim() || title.length > REPORT_STRING_LIMITS.title) {
    fail('Activity report title must be a non-empty string up to 256 characters.');
  }
  const normalized = { title: title.trim() };
  for (const field of ['artist', 'album', 'details', 'state']) {
    const value = report[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > REPORT_STRING_LIMITS[field]) {
      fail(`${field} must be a string up to 256 characters.`);
    }
    normalized[field] = value.trim();
  }
  for (const field of ['url', 'artwork']) {
    const value = cleanHttpsUrl(report[field], field);
    if (value) normalized[field] = value;
  }
  if (report.playing !== undefined) {
    if (typeof report.playing !== 'boolean') fail('playing must be a boolean.');
    normalized.playing = report.playing;
  }
  if (report.live !== undefined) {
    if (typeof report.live !== 'boolean') fail('live must be a boolean.');
    normalized.live = report.live;
  }
  for (const field of ['position', 'duration']) {
    if (report[field] === undefined) continue;
    if (typeof report[field] !== 'number' || !Number.isFinite(report[field]) || report[field] < 0 || report[field] > 31_536_000) {
      fail(`${field} must be a finite number between 0 and one year in seconds.`);
    }
    normalized[field] = report[field];
  }
  if (report.kind !== undefined) {
    if (typeof report.kind !== 'string' || !ACTIVITY_KINDS.has(report.kind)) {
      fail('kind must be one of the supported generic Activity kinds.');
    }
    normalized.kind = report.kind;
  }
  if (report.buttons !== undefined) {
    if (!Array.isArray(report.buttons) || report.buttons.length > 2) fail('buttons must contain at most two items.');
    normalized.buttons = report.buttons.map((button, index) => {
      if (!isPlainObject(button) || Object.keys(button).some((key) => !['label', 'url'].includes(key))) {
        fail(`button ${index + 1} must contain only label and url.`);
      }
      if (typeof button.label !== 'string' || !button.label.trim() || button.label.length > 32) {
        fail(`button ${index + 1} label must be 1 to 32 characters.`);
      }
      const url = cleanHttpsUrl(button.url, 'url');
      if (!url) fail(`button ${index + 1} must have a valid HTTPS URL.`);
      return { label: button.label.trim(), url };
    });
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
