import { DISCORD_CLIENT_ID } from '../config.js';

const API_BASE = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const AUTH_STORAGE_KEY = 'discordAuth';
const AUTH_CLIENT_ID_STORAGE_KEY = 'discordAuthClientId';
const PENDING_STORAGE_KEY = 'discordPendingOAuth';
const SCOPES = ['openid', 'sdk.social_layer_presence'];

let auth = null;
let initialized = false;
let refreshPromise = null;

export class DiscordRateLimitError extends Error {
  constructor(retryAfterMs) {
    const delay = Math.max(1_000, Math.ceil(Number(retryAfterMs) || 5_000));
    super(`Discord is rate limiting requests. Retrying in ${Math.ceil(delay / 1_000)} seconds.`);
    this.name = 'DiscordRateLimitError';
    this.retryAfterMs = delay;
  }
}

export function rateLimitErrorFromResponse(response, result = {}) {
  const retryAfterSeconds = Number(result?.retry_after ?? response.headers.get('retry-after'));
  return new DiscordRateLimitError(
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 5_000,
  );
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomBase64Url(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value) {
  const encoded = new TextEncoder().encode(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
}

async function persistAuth() {
  if (auth) {
    await chrome.storage.local.set({
      [AUTH_STORAGE_KEY]: auth,
      [AUTH_CLIENT_ID_STORAGE_KEY]: DISCORD_CLIENT_ID,
    });
  } else {
    await chrome.storage.local.remove([AUTH_STORAGE_KEY, AUTH_CLIENT_ID_STORAGE_KEY]);
  }
}

async function tokenRequest(parameters) {
  const body = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, ...parameters });
  const response = await fetch(`${API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw rateLimitErrorFromResponse(response, result);
    throw new Error(result.error_description || result.message || `Discord OAuth failed (${response.status}).`);
  }

  auth = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token || auth?.refreshToken || '',
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in) - 60 || 3540) * 1000,
    scope: result.scope || SCOPES.join(' '),
    user: auth?.user || null,
  };
  await persistAuth();
  return auth.accessToken;
}

async function refreshAccessToken() {
  if (!auth?.refreshToken) throw new Error('Discord authorization expired. Connect again.');
  if (!refreshPromise) {
    refreshPromise = tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function initializeAuth() {
  if (initialized) return;
  const stored = await chrome.storage.local.get([AUTH_STORAGE_KEY, AUTH_CLIENT_ID_STORAGE_KEY]);
  auth = stored[AUTH_CLIENT_ID_STORAGE_KEY] === DISCORD_CLIENT_ID
    ? stored[AUTH_STORAGE_KEY] || null
    : null;
  if (!auth && stored[AUTH_STORAGE_KEY]) await persistAuth();
  initialized = true;
}

export async function getRedirectUrl() {
  // Firefox derives the OAuth callback from the installed add-on ID. Asking the
  // platform avoids the Chromium-specific chromiumapp.org redirect used by the
  // original extension.
  return chrome.identity.getRedirectURL();
}

export function getClientId() {
  return DISCORD_CLIENT_ID;
}

export function getAuthState() {
  return {
    configured: true,
    authenticated: Boolean(auth?.accessToken),
    user: auth?.user || null,
  };
}

export async function getAccessToken(forceRefresh = false) {
  await initializeAuth();
  if (!auth?.accessToken) throw new Error('Connect Discord first.');
  if (!forceRefresh && Date.now() < auth.expiresAt) return auth.accessToken;
  return refreshAccessToken();
}

export async function discordRequest(path, options = {}, retry = true) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && retry && auth?.refreshToken) {
    await getAccessToken(true);
    return discordRequest(path, options, false);
  }
  if (response.status === 204) return null;

  const result = await response.json().catch(() => ({}));
  if (response.status === 429) throw rateLimitErrorFromResponse(response, result);
  if (!response.ok) throw new Error(result.message || `Discord API failed (${response.status}).`);
  return result;
}

export async function authorize() {
  await initializeAuth();
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(24);
  const challenge = await sha256Base64Url(verifier);
  const pending = { verifier, state, createdAt: Date.now() };
  await chrome.storage.session.set({ [PENDING_STORAGE_KEY]: pending });
  const redirectUrl = await getRedirectUrl();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUrl);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  try {
    const redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    if (!redirect) throw new Error('Discord authorization was cancelled.');
    const callback = new URL(redirect);
    if (callback.searchParams.get('state') !== state) throw new Error('Discord OAuth state mismatch.');
    const code = callback.searchParams.get('code');
    if (!code) {
      throw new Error(callback.searchParams.get('error_description') || 'Discord did not return an authorization code.');
    }

    await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUrl,
    });
    const user = await discordRequest('/oauth2/userinfo').catch(() => null);
    auth.user = user ? {
      id: user.sub || '',
      username: user.preferred_username || user.nickname || user.name || user.sub || 'Discord user',
    } : null;
    await persistAuth();
    return getAuthState();
  } finally {
    await chrome.storage.session.remove(PENDING_STORAGE_KEY);
  }
}

export async function revokeAuthorization() {
  await initializeAuth();
  const token = auth?.refreshToken || auth?.accessToken;
  if (token) {
    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      token,
      token_type_hint: auth?.refreshToken ? 'refresh_token' : 'access_token',
    });
    await fetch(`${API_BASE}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch(() => {});
  }
  auth = null;
  await persistAuth();
}
