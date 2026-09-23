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
const ACTIVITY_SETTING_ID = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const MAX_ACTIVITY_SETTINGS = 32;
const MAX_SETTING_OPTIONS = 32;

function settingError(message) {
  throw new TypeError(message);
}

function isSettingObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function validSettingValue(setting, value) {
  switch (setting.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'select':
      return setting.options.some((option) => option.value === value);
    case 'string':
      return typeof value === 'string' && value.length <= (setting.maxLength ?? 256);
    case 'number':
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < setting.min || value > setting.max) return false;
      if (setting.step === undefined) return true;
      const steps = (value - setting.min) / setting.step;
      return Math.abs(steps - Math.round(steps)) < 1e-8;
    }
    default:
      return false;
  }
}

export function validateActivitySettingDefinitions(definitions = []) {
  if (!Array.isArray(definitions) || definitions.length > MAX_ACTIVITY_SETTINGS) {
    settingError(`Activity settings must contain at most ${MAX_ACTIVITY_SETTINGS} definitions.`);
  }
  const ids = new Set();
  return definitions.map((input) => {
    if (!isSettingObject(input)) settingError('Activity setting definitions must be objects.');
    const { id, type, label, default: defaultValue } = input;
    if (typeof id !== 'string' || !ACTIVITY_SETTING_ID.test(id) || ids.has(id)) {
      settingError('Activity setting IDs must be unique lowercase identifiers.');
    }
    ids.add(id);
    if (!['boolean', 'select', 'string', 'number', 'range'].includes(type)) {
      settingError(`Activity setting ${id} has an unsupported type.`);
    }
    if (typeof label !== 'string' || !label.trim() || label.length > 80) {
      settingError(`Activity setting ${id} needs a label up to 80 characters.`);
    }
    const allowedFields = new Set(['id', 'type', 'label', 'default']);
    const normalized = { id, type, label: label.trim() };
    if (type === 'boolean') {
      if (typeof defaultValue !== 'boolean') settingError(`Activity setting ${id} must have a boolean default.`);
      normalized.default = defaultValue;
    } else if (type === 'select') {
      allowedFields.add('options');
      if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_SETTING_OPTIONS) {
        settingError(`Activity setting ${id} must have between 1 and ${MAX_SETTING_OPTIONS} select options.`);
      }
      const optionValues = new Set();
      normalized.options = input.options.map((option) => {
        if (!isSettingObject(option) || Object.keys(option).some((key) => !['label', 'value'].includes(key)) ||
            typeof option.label !== 'string' || !option.label.trim() || option.label.length > 80 ||
            typeof option.value !== 'string' || option.value.length > 128 || optionValues.has(option.value)) {
          settingError(`Activity setting ${id} has an invalid or duplicate select option.`);
        }
        optionValues.add(option.value);
        return { label: option.label.trim(), value: option.value };
      });
      if (typeof defaultValue !== 'string' || !optionValues.has(defaultValue)) {
        settingError(`Activity setting ${id} default must match one of its option values.`);
      }
      normalized.default = defaultValue;
    } else if (type === 'string') {
      allowedFields.add('maxLength');
      if (typeof defaultValue !== 'string') settingError(`Activity setting ${id} must have a string default.`);
      const maxLength = input.maxLength === undefined ? 256 : input.maxLength;
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 256 || defaultValue.length > maxLength) {
        settingError(`Activity setting ${id} maxLength must be from 1 to 256 and include its default.`);
      }
      normalized.default = defaultValue;
      normalized.maxLength = maxLength;
    } else {
      allowedFields.add('min');
      allowedFields.add('max');
      allowedFields.add('step');
      if (typeof input.min !== 'number' || !Number.isFinite(input.min) ||
          typeof input.max !== 'number' || !Number.isFinite(input.max) || input.min >= input.max ||
          typeof defaultValue !== 'number' || !Number.isFinite(defaultValue) ||
          (input.step !== undefined && (typeof input.step !== 'number' || !Number.isFinite(input.step) || input.step <= 0))) {
        settingError(`Activity setting ${id} needs finite min, max, default, and a positive optional step.`);
      }
      normalized.min = input.min;
      normalized.max = input.max;
      if (input.step !== undefined) normalized.step = input.step;
      normalized.default = defaultValue;
    }
    if (Object.keys(input).some((key) => !allowedFields.has(key))) {
      settingError(`Activity setting ${id} contains an unsupported field.`);
    }
    if (!validSettingValue(normalized, normalized.default)) {
      settingError(`Activity setting ${id} default is outside its allowed values.`);
    }
    return normalized;
  });
}

export function isValidActivitySettingValue(setting, value) {
  return validSettingValue(setting, value);
}

export function normalizeActivitySettings(definitions = [], values = {}) {
  const settings = {};
  const source = isSettingObject(values) ? values : {};
  for (const setting of definitions) {
    settings[setting.id] = validSettingValue(setting, source[setting.id])
      ? source[setting.id]
      : setting.default;
  }
  return settings;
}

export function mergeActivitySetting(definitions, current, id, value) {
  const setting = definitions.find((definition) => definition.id === id);
  if (!setting) settingError(`Unknown Activity setting ${String(id)}.`);
  if (!validSettingValue(setting, value)) settingError(`Value for Activity setting ${id} is invalid.`);
  return { ...normalizeActivitySettings(definitions, current), [id]: value };
}

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
