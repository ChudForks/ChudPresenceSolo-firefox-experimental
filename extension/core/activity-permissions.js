const REPOSITORY_ORIGINS = [
  'https://raw.githubusercontent.com',
  'https://api.github.com',
];

function apiRoot() {
  const api = globalThis.browser || globalThis.chrome;
  if (!api?.permissions) throw new Error('Firefox permissions API is unavailable.');
  return api;
}

export async function hasUserScriptsPermission(api = apiRoot()) {
  try {
    return await api.permissions.contains({ permissions: ['userScripts'] });
  } catch {
    return false;
  }
}

export async function hasHostPermissions(matches, api = apiRoot()) {
  return api.permissions.contains({ origins: [...new Set(matches)] });
}

export async function missingHostPermissions(matches, api = apiRoot()) {
  const missing = [];
  for (const match of new Set(matches)) {
    if (!await api.permissions.contains({ origins: [match] })) missing.push(match);
  }
  return missing;
}

export async function requestUserScriptsPermission(api = apiRoot()) {
  return api.permissions.request({ permissions: ['userScripts'] });
}

export async function requestHostPermissions(matches, api = apiRoot()) {
  return api.permissions.request({ origins: [...new Set(matches)] });
}

export async function requestRepositoryPermission(api = apiRoot()) {
  return api.permissions.request({ origins: REPOSITORY_ORIGINS.map((origin) => `${origin}/*`) });
}

export function watchPermissionChanges(onChange, api = apiRoot()) {
  api.permissions.onRemoved.addListener(onChange);
  api.permissions.onAdded.addListener(onChange);
  return () => {
    api.permissions.onRemoved.removeListener(onChange);
    api.permissions.onAdded.removeListener(onChange);
  };
}
