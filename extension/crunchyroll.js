const PLAYER_SOURCE = 'chudpresence-solo-crunchyroll-player';

let playerFrame = {
  currentTime: 0,
  duration: 0,
  paused: true,
  ended: false,
  hasVideo: false,
};

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== PLAYER_SOURCE || !data.hasVideo) return;
  playerFrame = {
    currentTime: Number(data.currentTime) || 0,
    duration: Number(data.duration) || 0,
    paused: Boolean(data.paused),
    ended: Boolean(data.ended),
    hasVideo: true,
  };
});

function textOf(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
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

function metaContent(names) {
  for (const name of names) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    const value = el?.content?.trim();
    if (value) return value;
  }
  return '';
}

function mediaIdFromPath() {
  const match = (location.pathname || '').match(/\/watch\/([A-Za-z0-9]+)/);
  return match ? match[1] : '';
}

function isWatchPage() {
  return /\/watch\//.test(location.pathname || '');
}

function parseIsoDuration(value) {
  if (!value || typeof value !== 'string') return 0;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function jsonLdItems() {
  const out = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent || 'null');
      for (const item of asList(parsed)) {
        if (item && typeof item === 'object') out.push(item);
        if (item?.['@graph']) out.push(...asList(item['@graph']));
      }
    } catch {
      // Crunchyroll sometimes emits invalid JSON-LD during navigation.
    }
  }
  return out;
}

function jsonLd() {
  const items = jsonLdItems();
  return (
    items.find((item) => {
      const type = String(item['@type'] || '');
      return (
        type.includes('TVEpisode') ||
        type.includes('Movie') ||
        type.includes('VideoObject') ||
        item.episodeNumber != null ||
        item.partOfSeries ||
        item.partOfSeason
      );
    }) ||
    items[0] ||
    null
  );
}

function seriesHref() {
  const href = firstHref([
    'a.show-title-link',
    '.show-title-link',
    '.erc-current-media-info a[href*="/series/"]',
    'a[href*="/series/"]',
  ]);
  if (!href) return '';
  try {
    const url = new URL(href, location.origin);
    if (!url.hostname.endsWith('crunchyroll.com')) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return href.split(/[?#]/)[0];
  }
}

function watchUrl(mediaId) {
  try {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    if (mediaId && !/\/watch\//.test(url.pathname)) {
      url.pathname = `/watch/${encodeURIComponent(mediaId)}`;
    }
    const href = url.toString();
    return href.length <= 512 ? href : href.slice(0, 512);
  } catch {
    return location.href.split(/[?#]/)[0];
  }
}

function pageTitle() {
  return (document.title || '')
    .replace(/\s+[|\-–]\s+Watch on Crunchyroll\s*$/i, '')
    .replace(/\s+[|\-–]\s+Crunchyroll\s*$/i, '')
    .replace(/^Watch\s+/i, '')
    .trim();
}

function parsePageTitle(raw) {
  const text = String(raw || '').trim();
  if (!text) return { series: '', episode: '', seasonNumber: 0, episodeNumber: 0 };
  const episodeSplit = text.match(/^(.*?)\s+Episode\s+(\d+)\s*[-–:]\s*(.+)$/i);
  if (episodeSplit) {
    return {
      series: episodeSplit[1].trim(),
      episode: episodeSplit[3].trim(),
      seasonNumber: 0,
      episodeNumber: Number(episodeSplit[2]) || 0,
    };
  }
  const shortSplit = text.match(/^(.*?)\s+(?:S(\d+)\s*)?E(\d+)\s*[-–:]\s*(.+)$/i);
  if (shortSplit) {
    return {
      series: shortSplit[1].trim(),
      episode: shortSplit[4].trim(),
      seasonNumber: Number(shortSplit[2]) || 0,
      episodeNumber: Number(shortSplit[3]) || 0,
    };
  }
  return { series: text, episode: '', seasonNumber: 0, episodeNumber: 0 };
}

function stripEpisodePrefix(name) {
  const title = String(name || '').trim();
  if (!title) return { name: '', seasonNumber: 0, episodeNumber: 0 };
  const prefixed = title.match(/^(?:S(\d+)\s*)?E(\d+)(?:\s*[—\-–:]\s*(.+))?$/i);
  if (prefixed) {
    return {
      name: (prefixed[3] || '').trim(),
      seasonNumber: Number(prefixed[1]) || 0,
      episodeNumber: Number(prefixed[2]) || 0,
    };
  }
  const words = title.match(/^Episode\s+(\d+)(?:\s*[—\-–:]\s*(.+))?$/i);
  if (words) {
    return {
      name: (words[2] || '').trim(),
      seasonNumber: 0,
      episodeNumber: Number(words[1]) || 0,
    };
  }
  return { name: title.replace(/\s+-\s+/g, ' — '), seasonNumber: 0, episodeNumber: 0 };
}

function formatSeasonEpisode(seasonName, seasonNumber, episodeNumber) {
  const name = String(seasonName || '').trim();
  const season = Number(seasonNumber);
  const episode = Number(episodeNumber);
  const hasSeason = Number.isFinite(season) && season > 0;
  const hasEpisode = Number.isFinite(episode) && episode > 0;
  if (name && /\bepisode\s+\d+\b/i.test(name)) return name;
  const episodeBit = hasEpisode ? `Episode ${episode}` : '';
  if (name && episodeBit) return `${name}, ${episodeBit}`;
  if (name) return name;
  if (hasSeason && episodeBit) return `Season ${season}, ${episodeBit}`;
  if (episodeBit) return episodeBit;
  if (hasSeason) return `Season ${season}`;
  return '';
}

function findVideo() {
  return (
    document.querySelector('#player-container video') ||
    document.querySelector('video[id^="bitmovinplayer-video"]') ||
    document.querySelector('#player0') ||
    document.querySelector('#player_html5_api') ||
    document.querySelector('.video-player video') ||
    document.querySelector('video')
  );
}

function isAd(video, duration) {
  if (
    document.querySelector(
      [
        '#vilosAdsContainer',
        '.vilos-ad',
        '[class*="ads-overlay"]',
        '[class*="ad-overlay"]',
        '[class*="preroll"]',
        '[data-testid*="ad" i]',
        '[aria-label*="Advertisement" i]',
        '[aria-label*="Skip Ad" i]',
      ].join(', '),
    )
  ) {
    return true;
  }
  const videoDur = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : 0;
  const frameDur = playerFrame.hasVideo ? playerFrame.duration : 0;
  const playingDur = videoDur || frameDur;
  return Boolean(duration > 90 && playingDur > 0 && playingDur < 75);
}

function isPlaying(video) {
  if (video && !video.paused && !video.ended) return true;
  if (playerFrame.hasVideo && !playerFrame.paused && !playerFrame.ended) return true;
  return false;
}

function imageUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.startsWith('data:') ? '' : value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = imageUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    return imageUrl(value.url || value.contentUrl || value.src || '');
  }
  return '';
}

function collect() {
  if (!isWatchPage()) {
    return { idle: true, title: '', playing: false, source: 'crunchyroll' };
  }

  const video = findVideo();
  const ld = jsonLd();
  const parsedTitle = parsePageTitle(pageTitle());
  const ldType = String(ld?.['@type'] || '');
  const movie = /Movie/i.test(ldType) && !ld?.episodeNumber && !ld?.partOfSeason;

  const series =
    firstText([
      'a.show-title-link h4',
      '.show-title-link h4',
      'a.show-title-link',
      '.show-title-link',
      '.erc-current-media-info a[href*="/series/"]',
      'a[href*="/series/"] h4',
    ]) ||
    ld?.partOfSeries?.name ||
    parsedTitle.series ||
    '';

  const rawEpisode =
    firstText([
      '.erc-current-media-info h1.title',
      '.erc-current-media-info h1',
      'h1.title',
      '[data-t="current-media-info"] h1',
    ]) ||
    ld?.name ||
    parsedTitle.episode ||
    '';

  const stripped = stripEpisodePrefix(rawEpisode);
  const seasonNumber =
    Number(ld?.partOfSeason?.seasonNumber) || stripped.seasonNumber || parsedTitle.seasonNumber || 0;
  const episodeNumber =
    Number(ld?.episodeNumber) || stripped.episodeNumber || parsedTitle.episodeNumber || 0;
  const episodeTitle = stripped.name || parsedTitle.episode || '';
  const seasonName =
    !movie && ld?.partOfSeason?.name && ld.partOfSeason.name !== series ? ld.partOfSeason.name : '';
  const title = movie
    ? series || episodeTitle || ld?.name || parsedTitle.series || pageTitle()
    : episodeTitle || series || pageTitle();
  const artist = movie ? '' : series;
  const album = movie ? '' : formatSeasonEpisode(seasonName, seasonNumber, episodeNumber);

  const mediaId = mediaIdFromPath() || String(ld?.identifier || ld?.['@id'] || '').match(/\/watch\/([A-Za-z0-9]+)/)?.[1] || '';

  const artwork =
    metaContent(['og:image', 'twitter:image']) ||
    imageUrl(ld?.image) ||
    imageUrl(ld?.thumbnailUrl) ||
    video?.poster ||
    '';

  const videoPos = Number.isFinite(video?.currentTime) ? video.currentTime : NaN;
  const videoDur = Number.isFinite(video?.duration) && video.duration > 0 ? video.duration : NaN;
  const framePos = playerFrame.hasVideo ? playerFrame.currentTime : NaN;
  const frameDur = playerFrame.hasVideo && playerFrame.duration > 0 ? playerFrame.duration : NaN;
  const ldDur = parseIsoDuration(ld?.duration);

  let duration = Number.isFinite(videoDur) ? videoDur : Number.isFinite(frameDur) ? frameDur : ldDur;
  let position = Number.isFinite(videoPos) ? videoPos : Number.isFinite(framePos) ? framePos : 0;

  // Preroll ads are short; keep the episode clock instead of the ad's.
  if (isAd(video, ldDur || duration) || (ldDur > 90 && duration > 0 && duration < 75)) {
    duration = ldDur || duration;
    if (duration > 90 && (Number.isFinite(videoDur) ? videoDur < 75 : frameDur < 75)) {
      position = 0;
    }
  }

  if (!title || (!mediaId && !episodeTitle && !series)) {
    return { idle: true, title: '', playing: false, source: 'crunchyroll' };
  }

  return {
    title,
    artist,
    album,
    artwork,
    videoId: mediaId,
    url: watchUrl(mediaId),
    channelUrl: seriesHref() || ld?.partOfSeries?.url || '',
    playing: isPlaying(video),
    position,
    duration: Number.isFinite(duration) ? duration : 0,
    ad: false,
    idle: false,
    live: false,
    source: 'crunchyroll',
    kind: movie ? 'movie' : 'episode',
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
    document.querySelector('#player-container'),
    document.querySelector('.erc-current-media-info'),
    document.querySelector('main'),
    document.querySelector('[data-t="watch-page"]'),
  ].filter(Boolean);
  const targets = nodes.length ? nodes : [document.documentElement];
  for (const node of targets) {
    observer.observe(node, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'title', 'aria-label', 'href', 'src', 'hidden', 'content'],
    });
  }
}

bindObserver();
setInterval(tick, 2000);
tick();

document.addEventListener('play', () => tick(), true);
document.addEventListener('pause', (event) => {
  if (unloading || event.target?.paused === false) return;
  tick();
}, true);

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
  bindObserver();
  tick();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'FORCE_TICK') return;
  unloading = false;
  lastSerialized = '';
  tick();
});
