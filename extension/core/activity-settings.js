export const DEFAULT_ACTIVITY_PREFERENCES = Object.freeze({
  showPaused: true,
  statusDisplay: 'app',
  showArtwork: true,
  showTimestamps: true,
  showButtons: true,
});

const BOOLEAN_PREFERENCES = new Set([
  'showPaused',
  'showArtwork',
  'showTimestamps',
  'showButtons',
]);
const STATUS_DISPLAY_VALUES = new Set(['app', 'artist', 'track']);

export function normalizeActivityPreferences(value = {}) {
  const normalized = { ...DEFAULT_ACTIVITY_PREFERENCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const key of BOOLEAN_PREFERENCES) {
    if (typeof value[key] === 'boolean') normalized[key] = value[key];
  }
  if (STATUS_DISPLAY_VALUES.has(value.statusDisplay)) normalized.statusDisplay = value.statusDisplay;
  return normalized;
}

export function mergeActivityPreferences(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Activity preferences must be an object.');
  }
  const next = normalizeActivityPreferences(current);
  for (const [key, value] of Object.entries(patch)) {
    if (BOOLEAN_PREFERENCES.has(key)) {
      if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
      next[key] = value;
      continue;
    }
    if (key === 'statusDisplay') {
      if (!STATUS_DISPLAY_VALUES.has(value)) {
        throw new TypeError('statusDisplay must be app, artist, or track.');
      }
      next.statusDisplay = value;
      continue;
    }
    throw new TypeError(`Unsupported Activity preference ${key}.`);
  }
  return next;
}
