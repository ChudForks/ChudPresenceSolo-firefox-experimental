import {
  authorize,
  DiscordRateLimitError,
  discordRequest,
  getAccessToken,
  getAuthState,
  getClientId,
  getRedirectUrl,
  initializeAuth,
  revokeAuthorization,
} from './auth.js';
import { buildHeadlessActivity } from './activity-builder.js';
import { armShutdownCleanup, disarmShutdownCleanup } from './shutdown-cleanup.js';

const SESSION_STORAGE_KEY = 'discordHeadlessSession';
const LAST_INTENT_STORAGE_KEY = 'discordLastIntent';
export const RENEW_ALARM = 'discord-presence-renew';
const ABSOLUTE_MIN_UPDATE_INTERVAL_MS = 4_200;
const MIN_UPDATE_INTERVAL_MS = 12_000;

let sessionToken = '';
let lastIntent = null;
let lastApplicationId = '';
let lastActivityIdentity = '';
let lastSentAt = 0;
let rateLimitUntil = 0;
let rateLimitTimer = 0;
let scheduledRateLimitUntil = 0;
let pendingIntent = null;
let pendingApplicationId = '';
let initialized = false;
let writeQueue = Promise.resolve();
let currentStatus = {
  id: 'discord-headless',
  available: false,
  state: 'starting',
  message: 'Starting the experimental Discord transport…',
};

function setStatus(state, message, available = false) {
  currentStatus = {
    id: 'discord-headless',
    available,
    state,
    message,
    ...getAuthState(),
  };
  return currentStatus;
}

function refreshIdleStatus() {
  const authState = getAuthState();
  if (!authState.configured) {
    return setStatus('configuration-required', 'Discord connection is unavailable in this build.', false);
  }
  if (!authState.authenticated) {
    return setStatus('disconnected', 'Connect Discord to start sharing your activity.', false);
  }
  return setStatus('connected', `Connected as ${authState.user?.username || 'Discord user'}.`, true);
}

function clearPendingRetry() {
  pendingIntent = null;
  pendingApplicationId = '';
  if (rateLimitTimer) clearTimeout(rateLimitTimer);
  rateLimitTimer = 0;
  scheduledRateLimitUntil = 0;
}

function retryDelayMessage(delayMs) {
  return `${Math.max(1, Math.ceil(delayMs / 1_000))} seconds`;
}

function scheduleRateLimitRetry() {
  if (!pendingIntent) return;
  if (rateLimitTimer && scheduledRateLimitUntil >= rateLimitUntil) return;
  if (rateLimitTimer) clearTimeout(rateLimitTimer);

  scheduledRateLimitUntil = rateLimitUntil;
  rateLimitTimer = setTimeout(() => {
    rateLimitTimer = 0;
    scheduledRateLimitUntil = 0;
    if (!pendingIntent || !getAuthState().authenticated) return;

    const intent = pendingIntent;
    const applicationId = pendingApplicationId;
    enqueue(() => updateSession(intent, applicationId, true))
      .then((result) => {
        currentStatus = result;
      })
      .catch((error) => {
        currentStatus = handleDeliveryError(error, intent, applicationId);
      });
  }, Math.max(0, rateLimitUntil - Date.now()));
}

function handleDeliveryError(error, intent, applicationId) {
  if (!(error instanceof DiscordRateLimitError)) {
    return setStatus('error', error.message || 'Discord presence update failed.', false);
  }

  rateLimitUntil = Math.max(rateLimitUntil, Date.now() + error.retryAfterMs);
  pendingIntent = intent;
  pendingApplicationId = applicationId || '';
  scheduleRateLimitRetry();
  return setStatus(
    'rate-limited',
    `Discord is rate limiting presence updates. Retrying in ${retryDelayMessage(rateLimitUntil - Date.now())}.`,
    false,
  );
}

function activityIdentity(activity) {
  if (!activity) return '';
  const { timestamps, ...stable } = activity;
  void timestamps;
  return JSON.stringify(stable);
}

async function saveSession() {
  if (sessionToken) await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: sessionToken });
  else await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

async function saveLastIntent() {
  if (lastIntent) {
    await chrome.storage.session.set({
      [LAST_INTENT_STORAGE_KEY]: { intent: lastIntent, applicationId: lastApplicationId },
    });
  }
  else await chrome.storage.session.remove(LAST_INTENT_STORAGE_KEY);
}

async function armCurrentShutdownCleanup() {
  if (!sessionToken || !getAuthState().authenticated) return false;
  const accessToken = await getAccessToken();
  return armShutdownCleanup(accessToken, sessionToken);
}

async function updateSession(intent, applicationId, force = false) {
  if (!getAuthState().authenticated) return refreshIdleStatus();
  if (rateLimitUntil > Date.now()) {
    throw new DiscordRateLimitError(rateLimitUntil - Date.now());
  }
  const activity = buildHeadlessActivity(intent, applicationId || getClientId());
  if (!activity) return clearSession();

  const identity = activityIdentity(activity);
  if (!force && Date.now() - lastSentAt < ABSOLUTE_MIN_UPDATE_INTERVAL_MS) return currentStatus;
  if (!force && identity === lastActivityIdentity && Date.now() - lastSentAt < MIN_UPDATE_INTERVAL_MS) {
    return currentStatus;
  }

  const body = { activities: [activity] };
  if (sessionToken) body.token = sessionToken;
  let result;
  try {
    result = await discordRequest('/users/@me/headless-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (!body.token || error instanceof DiscordRateLimitError) throw error;
    sessionToken = '';
    await saveSession();
    result = await discordRequest('/users/@me/headless-sessions', {
      method: 'POST',
      body: JSON.stringify({ activities: [activity] }),
    });
  }

  sessionToken = result?.token || sessionToken;
  lastIntent = intent;
  lastApplicationId = applicationId || '';
  lastActivityIdentity = identity;
  lastSentAt = Date.now();
  clearPendingRetry();
  await Promise.all([saveSession(), saveLastIntent()]);
  await armCurrentShutdownCleanup().catch(() => false);
  return setStatus('active', `Sharing activity as ${getAuthState().user?.username || 'your Discord account'}.`, true);
}

async function clearSession({ keepalive = false } = {}) {
  clearPendingRetry();
  if (!sessionToken && !lastIntent && !lastActivityIdentity) {
    await disarmShutdownCleanup().catch(() => {});
    return refreshIdleStatus();
  }
  lastIntent = null;
  lastApplicationId = '';
  lastActivityIdentity = '';
  lastSentAt = 0;
  const token = sessionToken;
  sessionToken = '';
  await Promise.all([saveSession(), saveLastIntent()]);

  if (token && getAuthState().authenticated) {
    await discordRequest('/users/@me/headless-sessions/delete', {
      method: 'POST',
      // Firefox 133+ can keep this authenticated request alive after the last
      // source document starts closing. It is deliberately limited to cleanup:
      // normal presence writes should not outlive their initiating context.
      keepalive,
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }
  await disarmShutdownCleanup().catch(() => {});
  return refreshIdleStatus();
}

function enqueue(operation) {
  writeQueue = writeQueue.catch(() => {}).then(operation);
  return writeQueue;
}

export const discordPresence = Object.freeze({
  async initialize() {
    if (initialized) return currentStatus;
    await initializeAuth();
    const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const transient = await chrome.storage.session.get(LAST_INTENT_STORAGE_KEY);
    sessionToken = String(stored[SESSION_STORAGE_KEY] || '');
    const savedPresence = transient[LAST_INTENT_STORAGE_KEY] || null;
    if (savedPresence?.intent) {
      lastIntent = savedPresence.intent;
      lastApplicationId = String(savedPresence.applicationId || '');
    } else {
      // Migrate the pre-service-profile session shape.
      lastIntent = savedPresence;
      lastApplicationId = '';
    }
    await chrome.alarms.create(RENEW_ALARM, { periodInMinutes: 10 });
    initialized = true;
    await armCurrentShutdownCleanup().catch(() => false);
    return refreshIdleStatus();
  },

  status() {
    return currentStatus;
  },

  async connect() {
    await this.initialize();
    setStatus('connecting', 'Finish signing in to Discord to continue…', false);
    try {
      await authorize();
      return refreshIdleStatus();
    } catch (error) {
      setStatus('error', error.message || 'Discord authorization failed.', false);
      throw error;
    }
  },

  async disconnect() {
    await this.initialize();
    await enqueue(clearSession);
    await revokeAuthorization();
    return refreshIdleStatus();
  },

  async publish(intent, applicationId = '', { closing = false } = {}) {
    await this.initialize();
    try {
      return await enqueue(() => (
        intent ? updateSession(intent, applicationId) : clearSession({ keepalive: closing })
      ));
    } catch (error) {
      return intent
        ? handleDeliveryError(error, intent, applicationId)
        : setStatus('error', error.message || 'Discord presence update failed.', false);
    }
  },

  async renew() {
    await this.initialize();
    if (!lastIntent || !getAuthState().authenticated) return refreshIdleStatus();
    try {
      return await enqueue(() => updateSession(lastIntent, lastApplicationId, true));
    } catch (error) {
      return handleDeliveryError(error, lastIntent, lastApplicationId);
    }
  },

  async getSetup() {
    return { clientId: getClientId(), redirectUrl: await getRedirectUrl(), ...getAuthState() };
  },
});
