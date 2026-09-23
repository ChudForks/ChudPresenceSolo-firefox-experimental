import {
  isSupportedActivityApiVersion,
  MAX_ACTIVITY_SOURCE_BYTES,
  isActivityId,
  isSemanticVersion,
  validateMatchPattern,
  validateActivityMetadata,
  validateActivitySource,
} from './activity-validator.js';
import { ACTIVITY_KIND_VALUES } from './activity-contract.generated.js';
import { MAX_ACTIVITY_ICON_BYTES, MAX_ACTIVITY_METADATA_BYTES } from './activity-contract.generated.js';

export const ACTIVITY_REPOSITORY = Object.freeze({
  owner: 'ChudForks',
  name: 'ChudPresence-Activities',
  branch: 'main',
  baseUrl: 'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/main/',
  rawBaseUrl: 'https://raw.githubusercontent.com/ChudForks/ChudPresence-Activities/',
  apiBaseUrl: 'https://api.github.com/repos/ChudForks/ChudPresence-Activities/',
  catalogPath: 'catalog.json',
});

const CATALOG_CACHE_KEY = 'activityCatalogCache';
const CATALOG_FETCHED_KEY = 'activityCatalogFetchedAt';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = MAX_ACTIVITY_METADATA_BYTES;
const MAX_ICON_BYTES = MAX_ACTIVITY_ICON_BYTES;
const DEFAULT_MEDIA_KINDS = new Set(ACTIVITY_KIND_VALUES);

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

function safeRepositoryPath(path, activityId, filename) {
  return typeof path === 'string' && path === `activities/${activityId}/${filename}`;
}

function validStringList(value, maxItems, maxLength, pattern = null) {
  return Array.isArray(value) && value.length <= maxItems && new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && item.trim() === item && item.length > 0 &&
      item.length <= maxLength && (!pattern || pattern.test(item)));
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      !Array.isArray(value.activities) || value.activities.length > 2000) {
    throw new Error('The Activities repository catalog has an unsupported format.');
  }
  if (value.revision !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.revision)) {
    throw new Error('The Activities repository catalog has an invalid repository revision.');
  }
  const seen = new Set();
  for (const entry of value.activities) {
    if (!entry || typeof entry !== 'object' || !isActivityId(entry.id) || seen.has(entry.id)) {
      throw new Error('The Activities repository catalog contains an invalid or duplicate entry.');
    }
    seen.add(entry.id);
    if (!safeRepositoryPath(entry.metadata, entry.id, 'metadata.json') ||
        !safeRepositoryPath(entry.entry, entry.id, 'activity.js') ||
        !/^[a-f0-9]{64}$/i.test(entry.metadataSha256 || '') ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
      throw new Error(`The catalog entry for ${entry.id} has invalid paths or integrity hashes.`);
    }
    if (typeof entry.name !== 'string' || typeof entry.description !== 'string' ||
        typeof entry.version !== 'string' || !Number.isInteger(entry.apiVersion) || entry.apiVersion < 1 ||
        entry.name.length > 80 || entry.description.length > 500 ||
        !isSemanticVersion(entry.version) ||
        !Array.isArray(entry.matches) || entry.matches.length < 1 || entry.matches.length > 32 ||
        new Set(entry.matches).size !== entry.matches.length || !entry.matches.every(validateMatchPattern)) {
      throw new Error(`The catalog entry for ${entry.id} is missing required display or API fields.`);
    }
    if (entry.minExtensionVersion !== undefined && !isSemanticVersion(entry.minExtensionVersion)) {
      throw new Error(`The catalog entry for ${entry.id} has an invalid minimum extension version.`);
    }
    if (entry.network !== undefined &&
        (!Array.isArray(entry.network) || entry.network.length > 32 ||
         new Set(entry.network).size !== entry.network.length ||
         !entry.network.every(validateMatchPattern) ||
         entry.network.some((pattern) => /^(?:https:\/\/)(?:\*\.)?(?:[^/]*\.)?(?:discord\.com|discordapp\.com|discordapp\.net)\//i.test(pattern)))) {
      throw new Error(`The catalog entry for ${entry.id} has invalid network permissions.`);
    }
    if (entry.category !== undefined &&
        (typeof entry.category !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.category))) {
      throw new Error(`The catalog entry for ${entry.id} has an invalid category.`);
    }
    if (entry.defaultMediaKind !== undefined &&
        !DEFAULT_MEDIA_KINDS.has(entry.defaultMediaKind)) {
      throw new Error(`The catalog entry for ${entry.id} has an invalid default media kind.`);
    }
    if (entry.author !== undefined &&
        (!entry.author || typeof entry.author !== 'object' || Array.isArray(entry.author) ||
         typeof entry.author.name !== 'string' || !entry.author.name.trim() || entry.author.name.length > 80 ||
         Object.keys(entry.author).some((key) => !['name', 'url'].includes(key)) ||
         (entry.author.url !== undefined && !validHttpsUrl(entry.author.url)))) {
      throw new Error(`The catalog entry for ${entry.id} has an invalid author.`);
    }
    if (entry.aliases !== undefined && !validStringList(entry.aliases, 32, 80)) {
      throw new Error(`The catalog entry for ${entry.id} has invalid aliases.`);
    }
    if (entry.tags !== undefined && !validStringList(entry.tags, 32, 32, /^[a-z0-9][a-z0-9-]{0,31}$/)) {
      throw new Error(`The catalog entry for ${entry.id} has invalid tags.`);
    }
    if (entry.excludeMatches !== undefined &&
        (!Array.isArray(entry.excludeMatches) || entry.excludeMatches.length > 32 ||
         new Set(entry.excludeMatches).size !== entry.excludeMatches.length || !entry.excludeMatches.every(validateMatchPattern))) {
      throw new Error(`The catalog entry for ${entry.id} has invalid excludeMatches.`);
    }
    if (entry.contributors !== undefined &&
        (!Array.isArray(entry.contributors) || entry.contributors.length > 16 || entry.contributors.some((person) =>
          !person || typeof person !== 'object' || Array.isArray(person) || typeof person.name !== 'string' ||
          !person.name.trim() || person.name.length > 80 || Object.keys(person).some((key) => !['name', 'url'].includes(key)) ||
          (person.url !== undefined && !validHttpsUrl(person.url))))) {
      throw new Error(`The catalog entry for ${entry.id} has invalid contributors.`);
    }
    for (const field of ['serviceUrl', 'homepage', 'repository']) {
      if (entry[field] !== undefined && !validHttpsUrl(entry[field])) {
        throw new Error(`The catalog entry for ${entry.id} has an invalid ${field}.`);
      }
    }
    if ((entry.icon === undefined && entry.iconSha256 !== undefined) ||
        (entry.icon !== undefined &&
         (!safeRepositoryPath(entry.icon, entry.id, 'icon.png') || !/^[a-f0-9]{64}$/i.test(entry.iconSha256 || '')))) {
      throw new Error(`The catalog entry for ${entry.id} has an invalid icon path or integrity hash.`);
    }
  }
  return value;
}

async function responseText(path, maxBytes, baseUrl = ACTIVITY_REPOSITORY.baseUrl) {
  const url = new URL(path, baseUrl);
  const base = new URL(baseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith('/ChudForks/ChudPresence-Activities/')) {
    throw new Error('Activity repository path is outside the configured repository.');
  }
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'application/json, text/plain;q=0.9' },
  });
  if (!response.ok) throw new Error(`Activity repository returned HTTP ${response.status}.`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('Repository file exceeds its size limit.');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Repository file exceeds its size limit.');
  return text;
}

async function responseBytes(path, maxBytes, baseUrl = ACTIVITY_REPOSITORY.baseUrl) {
  const url = new URL(path, baseUrl);
  const base = new URL(baseUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith('/ChudForks/ChudPresence-Activities/')) {
    throw new Error('Activity repository path is outside the configured repository.');
  }
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'image/png' },
  });
  if (!response.ok) throw new Error(`Activity repository returned HTTP ${response.status}.`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('Repository icon exceeds its size limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('Repository icon exceeds its size limit.');
  return bytes;
}

async function sha256(value) {
  const input = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const bytes = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function repositoryRevision() {
  const response = await fetch(new URL('commits/main', ACTIVITY_REPOSITORY.apiBaseUrl), {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`Could not resolve the Activities repository revision (HTTP ${response.status}).`);
  const result = await response.json();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(result?.sha || '')) {
    throw new Error('The Activities repository returned an invalid commit revision.');
  }
  return result.sha.toLowerCase();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function storageApi() {
  const storage = extensionApi()?.storage?.local;
  if (!storage) throw new Error('Extension storage is unavailable.');
  return storage;
}

export async function readCatalogCache() {
  const result = await storageApi().get([CATALOG_CACHE_KEY, CATALOG_FETCHED_KEY]);
  const catalog = result[CATALOG_CACHE_KEY];
  if (!catalog) return { catalog: null, fetchedAt: 0 };
  try {
    return { catalog: validateCatalog(catalog), fetchedAt: Number(result[CATALOG_FETCHED_KEY]) || 0 };
  } catch {
    return { catalog: null, fetchedAt: 0 };
  }
}

export async function fetchCatalog({ force = false } = {}) {
  const cached = await readCatalogCache();
  if (!force && cached.catalog?.revision) return { ...cached, fromCache: true };
  const revision = await repositoryRevision();
  const immutableBase = `${ACTIVITY_REPOSITORY.rawBaseUrl}${revision}/`;
  const text = await responseText(ACTIVITY_REPOSITORY.catalogPath, MAX_CATALOG_BYTES, immutableBase);
  let catalog;
  try {
    catalog = validateCatalog({ ...JSON.parse(text), revision });
  } catch (error) {
    throw new Error(`Could not read the Activities catalog: ${error.message}`);
  }
  const fetchedAt = Date.now();
  await storageApi().set({
    [CATALOG_CACHE_KEY]: catalog,
    [CATALOG_FETCHED_KEY]: fetchedAt,
  });
  return { catalog, fetchedAt, fromCache: false };
}

export async function downloadActivity(activityId, catalog) {
  const entry = catalog?.activities?.find((item) => item.id === activityId);
  if (!entry) throw new Error(`Activity ${activityId} is not present in the catalog.`);
  const revision = catalog.revision || await repositoryRevision();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) {
    throw new Error('Activity catalog does not identify a valid repository revision.');
  }
  const immutableBase = `${ACTIVITY_REPOSITORY.rawBaseUrl}${revision}/`;
  const [metadataText, source, iconBytes] = await Promise.all([
    responseText(entry.metadata, MAX_METADATA_BYTES, immutableBase),
    responseText(entry.entry, MAX_ACTIVITY_SOURCE_BYTES, immutableBase),
    entry.icon ? responseBytes(entry.icon, MAX_ICON_BYTES, immutableBase) : Promise.resolve(null),
  ]);
  if (await sha256(metadataText) !== entry.metadataSha256.toLowerCase()) {
    throw new Error('Activity metadata integrity check failed.');
  }
  if (await sha256(source) !== entry.sha256.toLowerCase()) {
    throw new Error('Activity code integrity check failed.');
  }
  if (iconBytes && await sha256(iconBytes) !== entry.iconSha256.toLowerCase()) {
    throw new Error('Activity icon integrity check failed.');
  }
  let metadata;
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(metadataText);
    metadata = validateActivityMetadata(packageMetadata);
  } catch (error) {
    throw new Error(`Activity metadata is invalid: ${error.message}`);
  }
  validateActivitySource(source);
  if (!isSupportedActivityApiVersion(metadata.apiVersion) || metadata.id !== entry.id ||
      ['name', 'description', 'version', 'apiVersion', 'minExtensionVersion', 'matches',
        'category', 'aliases', 'tags', 'excludeMatches', 'author', 'contributors',
        'serviceUrl', 'homepage', 'repository', 'presence', 'defaultMediaKind',
        'frames', 'network', 'settings']
        .some((field) => JSON.stringify(packageMetadata[field]) !== JSON.stringify(entry[field])) ||
      Boolean(metadata.icon) !== Boolean(iconBytes)) {
    throw new Error('Activity metadata does not match its catalog entry.');
  }
  const icon = iconBytes ? `data:image/png;base64,${bytesToBase64(iconBytes)}` : undefined;
  return {
    metadata,
    metadataSource: metadataText,
    source,
    ...(icon ? { icon } : {}),
    sourceType: 'repository',
    provenance: {
      repository: `${ACTIVITY_REPOSITORY.owner}/${ACTIVITY_REPOSITORY.name}`,
      revision: revision.toLowerCase(),
      codeSha256: entry.sha256.toLowerCase(),
      metadataSha256: entry.metadataSha256.toLowerCase(),
      ...(iconBytes ? { iconSha256: entry.iconSha256.toLowerCase() } : {}),
    },
  };
}

export function compareActivityVersions(left, right) {
  const parse = (version) => {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[^+]+)?$/);
    return match && {
      core: match.slice(1, 4).map((part) => BigInt(part)),
      prerelease: match[4] ? match[4].split('.') : null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumeric = /^\d+$/.test(a.prerelease[index]);
    const bNumeric = /^\d+$/.test(b.prerelease[index]);
    if (aNumeric && bNumeric) return BigInt(a.prerelease[index]) < BigInt(b.prerelease[index]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.prerelease[index].localeCompare(b.prerelease[index]);
  }
  return 0;
}
