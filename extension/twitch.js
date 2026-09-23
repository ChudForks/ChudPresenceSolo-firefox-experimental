const SOURCE = 'twitch';
const TWITCH_ORIGIN = 'https://www.twitch.tv';

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

function cleanPageTitle(value) {
  return String(value || '')
    .replace(/\s*(?:-\s*)?Twitch$/i, '')
    .replace(/^Twitch\s*-\s*/i, '')
    .trim();
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
  return document.querySelector('video[data-a-target="player-video"], .video-player video, video');
}

function channelName() {
  const fromPath = location.pathname.match(/^\/([^/?#]+)/)?.[1] || '';
  if (!fromPath || ['directory', 'downloads', 'jobs', 'login', 'p', 'search', 'settings', 'store', 'subscriptions', 'videos'].includes(fromPath)) {
    return '';
  }
  return fromPath;
}

function channelUrl() {
  const channel = channelName();
  return channel ? `${TWITCH_ORIGIN}/${encodeURIComponent(channel)}` : '';
}

function isVodRoute() {
  const path = location.pathname.toLowerCase();
  const query = new URLSearchParams(location.search);
  return path.startsWith('/videos/') || path.includes('/video/') || query.has('video');
}

function isLive(video) {
  if (video?.duration === Infinity) return true;
  // A channel can go live while its VOD is being watched in the same tab.
  // Route identity and a finite player duration describe the watched media;
  // channel-level badges do not.
  if (isVodRoute() || Number.isFinite(video?.duration)) return false;
  if (!channelName()) return false;
  return Boolean(document.querySelector(
    '[data-a-target="stream-title"], [data-a-target="player-live-badge"], [data-test-selector="live-indicator"]',
  ));
}

function isChannelLiveLabel(value) {
  return /\s*-\s*Live on Twitch\s*$/i.test(String(value || ''));
}

function videoObjectTitle() {
  const findVideoObject = (value) => {
    if (!value || typeof value !== 'object') return '';
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.includes('VideoObject') && typeof value.name === 'string' && value.name.trim()) {
      return value.name.trim();
    }
    for (const child of Object.values(value)) {
      if (typeof child !== 'object') continue;
      const title = Array.isArray(child)
        ? child.map(findVideoObject).find(Boolean)
        : findVideoObject(child);
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

function vodTitle(channel) {
  const session = mediaSession();
  const title = firstText([
    '[data-a-target="video-title"]',
    '[data-a-target="video-title-link"]',
    '[data-a-target="video-title"] h1',
    '[data-a-target="video-title"] h2',
  ]) || videoObjectTitle();
  if (title) return title;

  if (session.title && !isChannelLiveLabel(session.title)) return session.title;

  const streamHeading = firstText(['h2[data-a-target="stream-title"]']);
  if (streamHeading && !isChannelLiveLabel(streamHeading)) return streamHeading;

  const metadataTitle = meta('og:title');
  const titleSource = !isChannelLiveLabel(metadataTitle) ? metadataTitle : document.title;
  if (isChannelLiveLabel(titleSource)) return '';
  const pageTitle = cleanPageTitle(titleSource);
  if (!pageTitle) return '';
  if (channel) {
    const escapedChannel = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return pageTitle.replace(new RegExp(`\\s*-\\s*${escapedChannel}\\s*$`, 'i'), '').trim();
  }
  return pageTitle;
}

function streamTitle() {
  const session = mediaSession();
  return session.title || firstText([
    '[data-a-target="stream-title"]',
    'h2[data-a-target="stream-title"]',
  ]) || cleanPageTitle(meta('og:title'));
}

function artwork(session) {
  const image = session.artwork || meta('og:image');
  return image.startsWith('https://') ? image : '';
}

function collect() {
  const video = mainVideo();
  const channel = channelName();
  const session = mediaSession();
  const vod = isVodRoute() || (Number.isFinite(video?.duration) && video.duration > 0);
  const live = vod ? false : isLive(video);
  const title = vod ? vodTitle(channel) : streamTitle();

  // Twitch's browsing pages also expose Open Graph metadata. Require an active
  // player, or a channel stream title, so those pages never become activity.
  if (!title || (!video && !live)) {
    return { idle: true, title: '', playing: false, source: SOURCE };
  }

  const currentTime = Number.isFinite(video?.currentTime) ? video.currentTime : 0;
  const duration = !live && Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  const playing = Boolean(video && !video.paused && !video.ended);
  const url = location.href.split('#')[0];

  return {
    source: SOURCE,
    kind: live ? 'live' : 'video',
    live,
    title,
    artist: channel || session.artist,
    album: '',
    artwork: artwork(session),
    url,
    channelUrl: channelUrl(),
    playing,
    position: currentTime,
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
    chrome.runtime.sendMessage({ type: 'HEARTBEAT', track }).catch(() => {});
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
