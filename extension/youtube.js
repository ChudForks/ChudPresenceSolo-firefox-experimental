const SOURCE = 'chudpresence-solo';

let mediaSession = {
  playbackState: 'none',
  metadata: null,
  videoId: '',
  player: {},
  ad: false,
};

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  mediaSession = {
    playbackState: data.playbackState || 'none',
    metadata: data.metadata || null,
    videoId: data.videoId || '',
    player: data.player || {},
    ad: Boolean(data.ad || data.player?.ad),
  };
});

function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function videoIdFromHref(href) {
  if (!href) return '';
  try {
    const url = new URL(href, location.origin);
    const fromQuery = url.searchParams.get('v');
    if (fromQuery) return fromQuery;
    const fromPath = url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return fromPath ? fromPath[1] : '';
  } catch {
    const match = String(href).match(/(?:[?&]v=|\/(?:shorts|embed|live)\/)([\w-]{11})/);
    return match ? match[1] : '';
  }
}

function videoIdFromThumb(src) {
  const match = String(src || '').match(/\/vi(?:_webp)?\/([\w-]{11})\//);
  return match ? match[1] : '';
}

function videoIdFromPath() {
  const fromUrl = new URLSearchParams(location.search).get('v');
  if (fromUrl) return fromUrl;
  const match = (location.pathname || '').match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
  return match ? match[1] : '';
}

function bestArtwork(sessionArt, fallback) {
  const list = Array.isArray(sessionArt) ? sessionArt : [];
  let best = '';
  let bestScore = -1;
  for (const item of list) {
    const src = item?.src;
    if (!src || src.startsWith('data:')) continue;
    const size = parseInt(String(item.sizes || '').split('x')[0], 10) || 0;
    if (size >= bestScore) {
      best = src;
      bestScore = size;
    }
  }
  return best || fallback || '';
}

function firstText(selectors) {
  for (const selector of selectors) {
    const text = textOf(document.querySelector(selector));
    if (text) return text;
  }
  return '';
}

function firstHref(selectors) {
  for (const selector of selectors) {
    const href = document.querySelector(selector)?.href;
    if (href) return href;
  }
  return '';
}

function mainVideo() {
  return (
    document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('#shorts-player video.html5-main-video') ||
    document.querySelector('#movie_player video') ||
    document.querySelector('#shorts-player video') ||
    document.querySelector('ytd-miniplayer video.html5-main-video') ||
    document.querySelector('ytd-player video.html5-main-video') ||
    null
  );
}

function isShorts() {
  return (location.pathname || '').startsWith('/shorts/');
}

function isAd() {
  if (mediaSession.ad) return true;
  const player = document.querySelector('#movie_player, #shorts-player, .html5-video-player');
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) {
    return true;
  }
  return Boolean(
    document.querySelector(
      '.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-module .ytp-ad-player-overlay, ytd-ad-slot-renderer.ad-showing',
    ),
  );
}

function attrFlag(el, name) {
  if (!el?.hasAttribute(name)) return false;
  const value = String(el.getAttribute(name) || '').trim().toLowerCase();
  return value === '' || value === 'true' || value === name;
}

function isShown(el) {
  if (!el) return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.hidden || el.classList.contains('ytp-hidden')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

function isLive(player, video) {
  const flexy = document.querySelector('ytd-watch-flexy');
  if (attrFlag(flexy, 'is-live-video')) return true;

  const badgeShown = isShown(
    document.querySelector('#movie_player .ytp-live-badge, #shorts-player .ytp-live-badge'),
  );
  if (badgeShown) return true;
  if (video?.duration === Infinity) return true;

  // Finite duration with no LIVE control is a VOD, even if getVideoData
  // still has leftover livestream flags (isLiveContent on old broadcasts).
  if (player?.isLive === true) {
    const duration = video?.duration;
    if (Number.isFinite(duration) && duration > 0) return false;
    return true;
  }
  return false;
}

function isPlaying(video, player) {
  // The <video> element is the source of truth. getPlayerState() and
  // MediaSession lag on tab close / background throttle and otherwise
  // report paused while audio is still going.
  if (video && !video.paused && !video.ended) return true;
  if (video && video.paused && !video.ended) {
    const state = player?.playerState;
    if (state === 1 || state === 3) return true;
    return false;
  }
  const state = player?.playerState;
  if (state === 1 || state === 3) return true;
  if (mediaSession.playbackState === 'playing') return true;
  if (state === 2 || state === 0 || state === 5) return false;

  const button = document.querySelector('.ytp-play-button');
  const label = `${button?.getAttribute('title') || ''} ${button?.getAttribute('aria-label') || ''}`.toLowerCase();
  if (label.includes('pause')) return true;
  if (label.includes('play')) return false;
  return false;
}

function watchTitle() {
  return firstText([
    'ytd-watch-metadata h1 yt-formatted-string',
    '#title h1 yt-formatted-string',
    'h1.ytd-watch-metadata yt-formatted-string',
    'h1.ytd-watch-metadata',
    '.ytp-title-link',
    'ytd-miniplayer .miniplayer-title',
    'ytd-miniplayer yt-formatted-string',
    'ytd-miniplayer .ytp-miniplayer-video-title',
  ]);
}

function shortsTitle() {
  return firstText([
    'ytd-reel-player-overlay-renderer h2',
    'yt-reel-player-header-renderer h2',
    'ytd-reel-player-header-renderer h2',
    'ytd-reel-video-renderer[is-active] h2',
    '#shorts-player .ytp-title-link',
  ]);
}

function channelName() {
  return firstText([
    '#owner #channel-name a',
    'ytd-video-owner-renderer #channel-name a',
    'ytd-video-owner-renderer ytd-channel-name a',
    '#upload-info #channel-name a',
    'ytd-channel-name a',
    'ytd-reel-player-overlay-renderer ytd-channel-name a',
    'yt-reel-channel-bar-view-model a',
    'ytd-reel-player-header-renderer a',
    '.ytd-channel-name a',
  ]);
}

function channelHref() {
  const href = firstHref([
    '#owner #channel-name a',
    'ytd-video-owner-renderer #channel-name a',
    'ytd-video-owner-renderer ytd-channel-name a',
    '#upload-info #channel-name a',
    'ytd-channel-name a',
    'yt-reel-channel-bar-view-model a',
    'ytd-reel-player-header-renderer a',
  ]);
  if (!href) return '';
  try {
    const url = new URL(href, location.origin);
    if (!url.hostname.endsWith('youtube.com')) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return href.split('?')[0];
  }
}

function pageTitle() {
  const raw = (document.title || '').replace(/\s+-\s+YouTube$/i, '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower === 'youtube' || lower === 'home' || lower === 'shorts') return '';
  return raw;
}

function collect() {
  const video = mainVideo();
  const metadata = mediaSession.metadata || {};
  const player = mediaSession.player || {};
  const shorts = isShorts();

  if (isAd()) {
    return { ad: true, idle: false, title: '', playing: false, source: 'youtube' };
  }

  const videoId =
    mediaSession.videoId ||
    player.videoId ||
    videoIdFromPath() ||
    document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') ||
    videoIdFromHref(document.querySelector('link[rel="canonical"]')?.href) ||
    videoIdFromHref(document.querySelector('a.ytp-title-link')?.href) ||
    videoIdFromThumb(document.querySelector('#movie_player .ytp-cued-thumbnail-overlay-image')?.style?.backgroundImage) ||
    '';

  const title =
    player.title ||
    metadata.title ||
    (shorts ? shortsTitle() : watchTitle()) ||
    pageTitle() ||
    '';

  const artist = player.author || metadata.artist || channelName() || '';
  const artwork = bestArtwork(
    metadata.artwork,
    videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '',
  );

  const videoPos = Number.isFinite(video?.currentTime) ? video.currentTime : NaN;
  const videoDur = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : NaN;
  const playerPos = Number.isFinite(player.currentTime) ? player.currentTime : NaN;
  const playerDur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : NaN;

  let position = Number.isFinite(playerPos) ? playerPos : Number.isFinite(videoPos) ? videoPos : 0;
  let duration = Number.isFinite(playerDur) ? playerDur : Number.isFinite(videoDur) ? videoDur : 0;

  const live = isLive(player, video);
  if (live) duration = 0;

  if (!title || !videoId) {
    return { idle: true, title: '', playing: false, source: 'youtube' };
  }

  const kind = shorts ? 'short' : live ? 'live' : 'video';
  const url = videoId
    ? shorts
      ? `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`
      : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : location.href.startsWith('https://www.youtube.com/')
      ? location.href.split('&')[0]
      : '';

  return {
    title,
    artist,
    album: '',
    artwork,
    videoId,
    url,
    channelUrl: channelHref(),
    playing: isPlaying(video, player),
    position,
    duration,
    ad: false,
    idle: false,
    live,
    source: 'youtube',
    kind,
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

const observer = new MutationObserver(() => tick());

function bindObserver() {
  observer.disconnect();
  const nodes = [
    document.querySelector('#movie_player'),
    document.querySelector('#shorts-player'),
    document.querySelector('ytd-watch-flexy'),
    document.querySelector('ytd-watch-metadata'),
    document.querySelector('ytd-miniplayer'),
    document.querySelector('ytd-player'),
    document.querySelector('ytd-reel-video-renderer[is-active]'),
    document.querySelector('ytd-reel-player-overlay-renderer'),
  ].filter(Boolean);

  const targets = nodes.length ? nodes : [document.documentElement];
  for (const node of targets) {
    observer.observe(node, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'title', 'aria-label', 'href', 'src', 'hidden', 'video-id'],
    });
  }
}

bindObserver();
setInterval(tick, 2000);
tick();

document.addEventListener('yt-navigate-finish', () => {
  lastSerialized = '';
  bindObserver();
  tick();
});

document.addEventListener('yt-page-data-updated', () => {
  lastSerialized = '';
  tick();
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
      if (unloading) return;
      setTimeout(connectPresence, 250);
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
