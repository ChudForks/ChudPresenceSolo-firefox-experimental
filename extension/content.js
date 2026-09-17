const SOURCE = 'chudpresence-solo';

let mediaSession = {
  playbackState: 'none',
  metadata: null,
  videoId: '',
};

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  mediaSession = {
    playbackState: data.playbackState || 'none',
    metadata: data.metadata || null,
    videoId: data.videoId || '',
  };
});

function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseClock(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function parseTimeInfo(raw) {
  if (!raw) return { position: 0, duration: 0 };
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const [left, right] = cleaned.split('/');
  return {
    position: parseClock(left),
    duration: parseClock(right),
  };
}

function videoIdFromHref(href) {
  if (!href) return '';
  try {
    return new URL(href, location.origin).searchParams.get('v') || '';
  } catch {
    const match = String(href).match(/[?&]v=([\w-]{11})/);
    return match ? match[1] : '';
  }
}

function videoIdFromThumb(src) {
  const match = String(src || '').match(/\/vi\/([\w-]{11})\//);
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

function isAd() {
  return Boolean(
    document.querySelector('.ytmusic-player-bar.advertisement') ||
      document.querySelector('.ad-showing') ||
      document.querySelector('ytmusic-player-bar[is-advertisement]'),
  );
}

function isPlaying(video) {
  if (video && !video.paused && !video.ended) return true;
  if (mediaSession.playbackState === 'playing') return true;

  const button = document.querySelector(
    '#play-pause-button, ytmusic-player-bar #play-pause-button, ytmusic-player-bar .play-pause-button',
  );
  const label = `${button?.getAttribute('title') || ''} ${button?.getAttribute('aria-label') || ''}`.toLowerCase();
  if (label.includes('pause')) return true;
  if (label.includes('play')) return false;
  return false;
}

function collect() {
  const bar = document.querySelector('ytmusic-player-bar');
  const video = document.querySelector('video');
  const metadata = mediaSession.metadata || {};

  const title =
    textOf(bar?.querySelector('.title')) ||
    metadata.title ||
    '';

  const bylineLinks = [...(bar?.querySelectorAll('.byline a, .subtitle a') || [])]
    .map((a) => textOf(a))
    .filter(Boolean);

  const artist =
    metadata.artist ||
    bylineLinks[0] ||
    textOf(bar?.querySelector('.byline, .subtitle')) ||
    '';

  const rawAlbum = metadata.album || bylineLinks[1] || '';
  const album =
    rawAlbum && !rawAlbum.toLowerCase().includes((title.split('(')[0] || '').trim().toLowerCase())
      ? rawAlbum
      : '';

  const image = bar?.querySelector('img.image, .image img, .thumbnail-image-wrapper img');
  const artwork = bestArtwork(metadata.artwork, image?.src || '');

  const videoId =
    mediaSession.videoId ||
    new URLSearchParams(location.search).get('v') ||
    videoIdFromHref(bar?.querySelector('a.yt-simple-endpoint[href*="watch"]')?.href) ||
    videoIdFromHref(bar?.querySelector('.title')?.closest('a')?.href) ||
    videoIdFromHref(image?.closest('a')?.href) ||
    videoIdFromHref(document.querySelector('link[rel="canonical"]')?.href) ||
    videoIdFromHref(document.querySelector('ytmusic-player a[href*="watch"]')?.href) ||
    videoIdFromThumb(image?.src) ||
    '';

  const times = parseTimeInfo(textOf(bar?.querySelector('.time-info')));
  const videoPos = Number.isFinite(video?.currentTime) ? video.currentTime : NaN;
  const videoDur = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : NaN;
  // The player bar clock updates with the new song first. The <video> element
  // often still holds the previous track's currentTime after a skip.
  let position = times.duration > 0 ? times.position : Number.isFinite(videoPos) ? videoPos : 0;
  let duration = times.duration > 0 ? times.duration : Number.isFinite(videoDur) ? videoDur : 0;

  if (isAd()) {
    return { ad: true, idle: false, title: '', playing: false };
  }

  if (!title) {
    return { idle: true, title: '', playing: false };
  }

  return {
    title,
    artist,
    album,
    artwork,
    videoId,
    url: videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : '',
    playing: isPlaying(video),
    position,
    duration,
    ad: false,
    idle: false,
    live: false,
    source: 'youtubeMusic',
    kind: 'song',
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
const startObserver = () => {
  const bar = document.querySelector('ytmusic-player-bar') || document.documentElement;
  observer.observe(bar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
};

startObserver();
setInterval(tick, 2000);
tick();

document.addEventListener('yt-navigate-finish', () => {
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
