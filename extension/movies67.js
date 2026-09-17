const SOURCE = 'movies67';
const TMDB_API_KEY = 'a46c50a0ccb1bafe2b15665df7fad7e1';
const PLAYER_ORIGINS = new Set([
  'https://111movies.net',
  'https://player.vidlove.cc',
  'https://player.videasy.net',
  'https://vidsuper.net',
]);

let metadata = null;
let metadataKey = '';
let metadataRetryAt = 0;
let sharingEnabled = false;
let player = {
  position: 0,
  duration: 0,
  playing: false,
  ended: false,
  updatedAt: 0,
};

function routeFromPath(pathname, prefix = 'watch') {
  const match = (pathname || '').match(
    new RegExp(`^/${prefix}/(movie|tv)/(\\d+)(?:/(\\d+)/(\\d+))?/?$`, 'i'),
  );
  if (!match) return null;
  const type = match[1].toLowerCase();
  const season = Number(match[3]) || 0;
  const episode = Number(match[4]) || 0;
  if (type === 'tv' && (!season || !episode)) return null;
  return {
    type,
    id: match[2],
    season,
    episode,
    key: `${type}:${match[2]}:${season}:${episode}`,
  };
}

function playerRouteInfo(pageRoute) {
  if (pageRoute?.type !== 'tv') return null;

  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const url = new URL(frame.src);
      if (!PLAYER_ORIGINS.has(url.origin)) continue;
      const route = routeFromPath(url.pathname, 'embed');
      if (route?.type === pageRoute.type && route.id === pageRoute.id) return route;
    } catch {
      // Ignore incomplete iframe URLs while the site's player is switching episodes.
    }
  }
  return null;
}

function routeInfo() {
  const pageRoute = routeFromPath(location.pathname);
  return playerRouteInfo(pageRoute) || pageRoute;
}

function progressKey(route) {
  return route.type === 'tv'
    ? `progress:t${route.id}:s${route.season}:e${route.episode}`
    : `progress:m${route.id}`;
}

function continueWatchingKey(route) {
  return route.type === 'tv'
    ? `tv-${route.id}-${route.season}-${route.episode}`
    : `movie-${route.id}`;
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function storedProgress(route) {
  const direct = readJson(progressKey(route));
  let watched = Number(direct?.position);
  let duration = Number(direct?.duration);

  if (!(duration > 0)) {
    const history = readJson('continueWatching');
    const saved = history?.[continueWatchingKey(route)]?.progress;
    watched = Number(saved?.watched);
    duration = Number(saved?.duration);
  }

  return {
    position: Number.isFinite(watched) && watched >= 0 ? watched : 0,
    duration: Number.isFinite(duration) && duration > 1 ? duration : 0,
  };
}

function storedTitle(route) {
  const history = readJson('continueWatching');
  const title = history?.[continueWatchingKey(route)]?.title;
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
}

function image(path, size = 'w500') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

async function tmdb(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `https://api.themoviedb.org/3/${path}${separator}api_key=${TMDB_API_KEY}&language=en-US`,
  );
  if (!response.ok) throw new Error(`TMDB HTTP ${response.status}`);
  return response.json();
}

async function loadMetadata(route) {
  const requestedKey = route.key;
  metadataKey = requestedKey;
  metadata = null;
  metadataRetryAt = 0;
  try {
    if (route.type === 'movie') {
      const movie = await tmdb(`movie/${route.id}`);
      if (metadataKey !== requestedKey) return;
      metadata = {
        title: movie.title || movie.original_title || storedTitle(route),
        artist: '',
        album: movie.release_date?.slice(0, 4) || '',
        artwork: image(movie.poster_path || movie.backdrop_path),
        duration: Number(movie.runtime) > 0 ? Number(movie.runtime) * 60 : 0,
      };
    } else {
      const [show, season] = await Promise.all([
        tmdb(`tv/${route.id}`),
        tmdb(`tv/${route.id}/season/${route.season}`),
      ]);
      if (metadataKey !== requestedKey) return;
      const episode = (season.episodes || []).find(
        (item) => Number(item.episode_number) === route.episode,
      );
      const seriesTitle = show.name || show.original_name || storedTitle(route);
      metadata = {
        title: episode?.name || seriesTitle,
        artist: seriesTitle,
        album: `Season ${route.season}, Episode ${route.episode}`,
        artwork: image(episode?.still_path || show.poster_path || show.backdrop_path),
        duration:
          Number(episode?.runtime) > 0
            ? Number(episode.runtime) * 60
            : Number(show.episode_run_time?.[0]) > 0
              ? Number(show.episode_run_time[0]) * 60
              : 0,
      };
    }
    metadataRetryAt = 0;
  } catch {
    if (metadataKey !== requestedKey) return;
    metadataRetryAt = Date.now() + 30_000;
    metadata = {
      title: storedTitle(route),
      artist: route.type === 'tv' ? storedTitle(route) : '',
      album: route.type === 'tv' ? `Season ${route.season}, Episode ${route.episode}` : '',
      artwork: '',
      duration: 0,
    };
  }
  tick();
}

function ensureMetadata(route) {
  if (route.key !== metadataKey) {
    player = { position: 0, duration: 0, playing: false, ended: false, updatedAt: 0 };
    loadMetadata(route);
    return;
  }
  if (metadataRetryAt && Date.now() >= metadataRetryAt) {
    loadMetadata(route);
  }
}

function normalizedPlayerEvent(event) {
  if (!PLAYER_ORIGINS.has(event.origin) || !event.data) return null;
  const data = event.data;

  if (event.origin === 'https://111movies.net' && typeof data === 'object') {
    return {
      event: String(data.event || '').toLowerCase(),
      position: Number(data.data?.currentTime),
      duration: Number(data.data?.duration),
    };
  }

  if (event.origin === 'https://player.vidlove.cc' && typeof data === 'object') {
    if (data.type === 'MEDIA_DATA' && data.data?.progress) {
      return {
        event: 'timeupdate',
        position: Number(data.data.progress.watched),
        duration: Number(data.data.progress.duration),
      };
    }
    if (data.type === 'WATCH_PROGRESS' && data.data) {
      return {
        event: String(data.data.eventType || 'timeupdate').toLowerCase(),
        position: Number(data.data.currentTime),
        duration: Number(data.data.duration),
      };
    }
    if (data.type === 'PLAYER_EVENT' && data.data) {
      return {
        event: String(data.data.event || '').toLowerCase(),
        position: Number(data.data.currentTime),
        duration: Number(data.data.duration),
      };
    }
  }

  if (event.origin === 'https://player.videasy.net' && typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return {
        event: String(parsed.event || parsed.type || 'timeupdate').toLowerCase(),
        position: Number(parsed.timestamp),
        duration: Number(parsed.duration),
      };
    } catch {
      return null;
    }
  }

  if (event.origin === 'https://vidsuper.net') {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      return {
        event: String(parsed.type || '').toLowerCase(),
        position: Number(parsed.progress),
        duration: Number(parsed.duration),
      };
    } catch {
      return null;
    }
  }

  return null;
}

window.addEventListener('message', (event) => {
  if (!routeInfo()) return;
  const playerFrame = [...document.querySelectorAll('iframe')].find((frame) => {
    try {
      return new URL(frame.src).origin === event.origin;
    } catch {
      return false;
    }
  });
  if (!playerFrame || event.source !== playerFrame.contentWindow) return;
  const update = normalizedPlayerEvent(event);
  if (!update) return;

  const previousPosition = player.position;
  if (Number.isFinite(update.position) && update.position >= 0) {
    player.position = update.position;
  }
  if (Number.isFinite(update.duration) && update.duration > 1) {
    player.duration = update.duration;
  }

  if (['pause', 'paused', 'ended', 'complete', 'completed'].includes(update.event)) {
    player.playing = false;
    player.ended = update.event !== 'pause' && update.event !== 'paused';
  } else if (['play', 'playing', 'resume', 'timeupdate', 'progress'].includes(update.event)) {
    player.playing =
      update.event !== 'timeupdate' ||
      !Number.isFinite(update.position) ||
      update.position > previousPosition + 0.01 ||
      player.playing;
    player.ended = false;
  }
  player.updatedAt = Date.now();
  tick();
});

function watchUrl(route) {
  try {
    const url = new URL(location.href);
    url.pathname =
      route.type === 'tv'
        ? `/watch/tv/${route.id}/${route.season}/${route.episode}`
        : `/watch/movie/${route.id}`;
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 512);
  } catch {
    return '';
  }
}

function collect() {
  const route = routeInfo();
  if (!route) return { idle: true, title: '', playing: false, source: SOURCE };
  if (!sharingEnabled) return { idle: true, title: '', playing: false, source: SOURCE };
  ensureMetadata(route);

  const stored = storedProgress(route);
  const position = player.position || stored.position;
  const duration = player.duration || stored.duration || metadata?.duration || 0;
  const eventFresh = player.updatedAt && Date.now() - player.updatedAt < 8_000;
  const title = metadata?.title || storedTitle(route);

  if (!title) return { idle: true, title: '', playing: false, source: SOURCE };
  return {
    title,
    artist: metadata?.artist || '',
    album: metadata?.album || '',
    artwork: metadata?.artwork || '',
    videoId: route.key,
    url: watchUrl(route),
    channelUrl: '',
    playing: Boolean(player.playing && eventFresh && !player.ended),
    position,
    duration,
    ad: false,
    idle: false,
    live: false,
    source: SOURCE,
    kind: route.type === 'movie' ? 'movie' : 'episode',
  };
}

function push(track) {
  chrome.runtime.sendMessage({ type: 'TRACK_UPDATE', track }).catch(() => {});
}

let lastSerialized = '';
let unloading = false;

function tick() {
  if (unloading) return;
  const track = collect();
  const serialized = JSON.stringify(track);
  if (serialized === lastSerialized) {
    chrome.runtime.sendMessage({ type: 'HEARTBEAT' }).catch(() => {});
    return;
  }
  lastSerialized = serialized;
  push(track);
}

async function loadSharingPreference() {
  const stored = await chrome.storage.local.get({ enabled: true, sourceMovies67: true });
  sharingEnabled = Boolean(stored.enabled && stored.sourceMovies67);
  if (!sharingEnabled) {
    metadata = null;
    metadataKey = '';
    metadataRetryAt = 0;
  }
  tick();
}

const observer = new MutationObserver(() => tick());
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['src', 'hidden'],
});

setInterval(tick, 2000);
loadSharingPreference().catch(() => tick());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.enabled && !changes.sourceMovies67)) return;
  loadSharingPreference().catch(() => {});
});

function announceClose() {
  if (unloading) return;
  unloading = true;
  chrome.runtime.sendMessage({ type: 'TAB_CLOSING' }).catch(() => {});
}

function connectPresence() {
  try {
    const port = chrome.runtime.connect({ name: 'presence' });
    port.onDisconnect.addListener(() => {
      if (!unloading) setTimeout(connectPresence, 250);
    });
  } catch {
    if (!unloading) setTimeout(connectPresence, 1000);
  }
}

connectPresence();
window.addEventListener('beforeunload', announceClose);
window.addEventListener('pagehide', announceClose);
window.addEventListener('pageshow', () => {
  unloading = false;
  lastSerialized = '';
  connectPresence();
  tick();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'FORCE_TICK') return;
  unloading = false;
  lastSerialized = '';
  tick();
});
