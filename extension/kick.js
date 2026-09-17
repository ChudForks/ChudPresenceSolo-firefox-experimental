const SOURCE = 'kick';
const KICK_ORIGIN = 'https://kick.com';

function textOf(element) {
  return (element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(selectors) {
  for (const selector of selectors) {
    const text = textOf(document.querySelector(selector));
    if (text) return text;
  }
  return '';
}

function meta(name) {
  return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || '';
}

function mediaSession() {
  const metadata = navigator.mediaSession?.metadata;
  if (!metadata) return { title: '', artist: '', artwork: '' };
  const artwork = Array.isArray(metadata.artwork)
    ? [...metadata.artwork].reverse().find((item) => String(item?.src || '').startsWith('https://'))?.src || ''
    : '';
  return {
    title: String(metadata.title || '').trim(),
    artist: String(metadata.artist || '').trim(),
    artwork,
  };
}

function mainVideo() {
  return document.querySelector('video[data-testid="video-player"], .vjs-tech, .video-js video, video');
}

function channelName() {
  const name = location.pathname.match(/^\/([^/?#]+)/)?.[1] || '';
  const reserved = ['auth', 'browse', 'categories', 'login', 'register', 'search', 'subscriptions', 'video'];
  return name && !reserved.includes(name.toLowerCase()) ? name : '';
}

function channelUrl() {
  const channel = channelName();
  return channel ? `${KICK_ORIGIN}/${encodeURIComponent(channel)}` : '';
}

function isVodRoute() {
  const path = location.pathname.toLowerCase();
  return path.startsWith('/video/') || path.includes('/videos/') || path.includes('/clips/') || new URLSearchParams(location.search).has('clip');
}

function isLive(video) {
  if (video?.duration === Infinity) return true;
  // A broadcaster can begin a new live stream while a viewer is watching an
  // earlier recording. Never borrow the channel's live badge for a VOD.
  if (isVodRoute() || Number.isFinite(video?.duration) || !channelName()) return false;
  return Boolean(document.querySelector(
    '[data-testid="live-badge"], [data-testid="livestream-badge"], [data-testid="stream-is-live"], .live-badge',
  ));
}

function cleanPageTitle(value) {
  return String(value || '')
    .replace(/\s*(?:[-|]\s*)?Kick(?:\.com)?$/i, '')
    .replace(/^Kick(?:\.com)?\s*[-|]\s*/i, '')
    .trim();
}

function videoObjectTitle() {
  const findVideoObject = (value) => {
    if (!value || typeof value !== 'object') return '';
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('VideoObject') && typeof value.name === 'string' && value.name.trim()) return value.name.trim();
    for (const child of Object.values(value)) {
      if (!child || typeof child !== 'object') continue;
      const title = Array.isArray(child) ? child.map(findVideoObject).find(Boolean) : findVideoObject(child);
      if (title) return title;
    }
    return '';
  };

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const title = findVideoObject(JSON.parse(script.textContent || ''));
      if (title) return title;
    } catch {
      // Ignore unrelated or partially-written structured-data blocks.
    }
  }
  return '';
}

function videoTitle(vod, session) {
  const title = firstText(vod ? [
    '[data-testid="video-title"]',
    '[data-testid="vod-title"]',
    '[data-testid="clip-title"]',
    'h1',
  ] : [
    '[data-testid="livestream-title"]',
    '[data-testid="stream-title"]',
    '.channel-header h1',
  ]);
  if (title) return title;
  const structuredTitle = vod ? videoObjectTitle() : '';
  if (structuredTitle) return structuredTitle;
  if (session.title) return session.title;
  return cleanPageTitle(meta('og:title') || document.title);
}

function artwork(session) {
  const image = session.artwork || meta('og:image');
  return image.startsWith('https://') ? image : '';
}

function collect() {
  const video = mainVideo();
  const session = mediaSession();
  const vod = isVodRoute() || (Number.isFinite(video?.duration) && video.duration > 0);
  const live = vod ? false : isLive(video);
  const title = videoTitle(vod, session);

  if (!title || (!video && !live)) {
    return { idle: true, title: '', playing: false, source: SOURCE };
  }

  const position = Number.isFinite(video?.currentTime) ? video.currentTime : 0;
  const duration = !live && Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  const channel = channelName();
  return {
    source: SOURCE,
    kind: live ? 'live' : 'video',
    live,
    title,
    artist: channel || session.artist,
    album: '',
    artwork: artwork(session),
    url: location.href.split('#')[0],
    channelUrl: channelUrl(),
    playing: Boolean(video && !video.paused && !video.ended),
    position,
    duration,
    ad: false,
    idle: false,
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

const observer = new MutationObserver(tick);
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'content', 'src'],
});

document.addEventListener('play', tick, true);
document.addEventListener('pause', tick, true);
document.addEventListener('loadedmetadata', tick, true);
document.addEventListener('durationchange', tick, true);
window.addEventListener('popstate', () => {
  lastSerialized = '';
  tick();
});

setInterval(tick, 2_000);
tick();

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
    if (!unloading) setTimeout(connectPresence, 1_000);
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
