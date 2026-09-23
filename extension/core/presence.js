import { EXTENSION_NAME } from './branding.js';

const MAX_TEXT_LENGTH = 128;

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function isNormalizedActivityReport(track) {
  return Boolean(track?.media && track?.playback && track?.display && track?.artwork);
}

function reportForTrack(track) {
  if (isNormalizedActivityReport(track)) return track;
  const kind = track.kind === 'short' ? 'video' : track.kind === 'live' ? 'stream' : track.kind || 'generic';
  const media = {
    title: track.title,
    artist: track.artist,
    album: track.album,
    series: track.series || (kind === 'episode' ? track.artist : undefined),
    subtitle: track.subtitle,
    creator: track.creator,
    channel: track.channel,
    game: track.game,
    category: track.category,
  };
  const displayDefaults = (() => {
    if (kind === 'song') return { details: media.title, state: media.artist || '' };
    if (kind === 'episode') return { details: media.series || media.title, state: media.title };
    if (kind === 'stream') return { details: media.title, state: media.creator || media.channel || media.artist || '' };
    if (kind === 'movie') return { details: media.title, state: '' };
    if (kind === 'game') return { details: media.game || media.title, state: media.category || '' };
    return { details: track.details || media.title, state: track.state || media.artist || media.album || '' };
  })();
  const legacyArtwork = typeof track.artwork === 'string'
    ? { large: track.artwork, largeText: track.display?.largeText || media.album || media.title }
    : track.artwork || {};
  return {
    ...track,
    kind,
    media,
    playback: {
      state: track.playing === false ? 'paused' : 'playing',
      position: Number(track.position) || 0,
      duration: Number(track.duration) || 0,
      live: Boolean(track.live || track.kind === 'live'),
      rate: 1,
    },
    display: { ...displayDefaults, ...(track.display || {}) },
    artwork: legacyArtwork,
    buttons: Array.isArray(track.buttons)
      ? track.buttons
      : track.url ? [{ label: 'Open', url: track.url }] : [],
    visibility: track.ad ? 'ad' : track.idle ? 'idle' : 'normal',
  };
}

function activityType(report) {
  const declared = report.presenceKind;
  const type = declared === 'music'
    ? 'listening'
    : declared === 'video'
      ? 'watching'
      : declared === 'streaming'
        ? 'streaming'
        : declared === 'generic'
          ? 'playing'
          : report.kind === 'song'
            ? 'listening'
            : report.kind === 'stream'
              ? 'streaming'
              : report.kind === 'game' || report.kind === 'generic'
                ? 'playing'
                : 'watching';
  if (type !== 'streaming') return type;
  const hasSafeUrl = safeUrl(report.url) || safeUrl(report.buttons?.[0]?.url);
  return hasSafeUrl ? type : 'watching';
}

function timestamps(playback, nowMs) {
  if (playback.state !== 'playing') return null;
  const position = Math.max(0, Number(playback.position) || 0);
  const now = Math.floor(nowMs / 1000);
  if (playback.live) return { start: now - Math.floor(position) };
  const duration = Math.max(0, Number(playback.duration) || 0);
  if (!duration || position >= duration) return null;
  return { start: now - Math.floor(position), end: now + Math.ceil(duration - position) };
}

function statusDisplayType(report, settings) {
  const selected = report.display.statusFields?.[settings.statusDisplay];
  if (selected) return selected;
  if (settings.statusDisplay === 'app') return 'name';
  if (settings.statusDisplay === 'artist' || settings.statusDisplay === 'creator') return 'state';
  if (settings.statusDisplay === 'track' || settings.statusDisplay === 'video') return 'details';
  return report.display.statusDisplay || 'name';
}

/** Convert generic media data to a transport-neutral presence intent. */
export function createPresenceIntent(track, nowMs = Date.now(), settings = {}) {
  if (!track) return null;
  const report = reportForTrack(track);
  if (report.visibility !== 'normal' || !report.media?.title) return null;

  const name = cleanText(report.activityName || EXTENSION_NAME, 128);
  const details = cleanText(report.display.details || report.media.title);
  if (!details) return null;
  const paused = report.playback.state === 'paused';
  const markers = [report.playback.live && 'Live', paused && 'Paused'].filter(Boolean);
  const state = cleanText(report.display.state || report.media.artist || report.media.creator || name);
  const type = activityType(report);
  const streamUrl = safeUrl(report.url) || safeUrl(report.buttons?.[0]?.url);
  const art = settings.showArtwork === false ? null : report.artwork;
  const largeImage = safeUrl(art?.large);
  const smallImage = safeUrl(art?.small);
  const buttons = settings.showButtons === false
    ? []
    : (report.buttons || []).map((button) => {
        const url = safeUrl(button?.url);
        const label = cleanText(button?.label, 32);
        return url && label ? { label, url } : null;
      }).filter(Boolean).slice(0, 2);

  return {
    name,
    type,
    ...(type === 'streaming' && streamUrl ? { streamUrl } : {}),
    details,
    state: markers.length ? `${cleanText(state, MAX_TEXT_LENGTH - markers.join(' • ').length - 3)} • ${markers.join(' • ')}` : state,
    statusDisplayType: statusDisplayType(report, settings),
    timestamps: settings.showTimestamps === false ? null : timestamps(report.playback, nowMs),
    assets: largeImage ? {
      largeImage,
      largeText: cleanText(art.largeText || report.media.album || report.media.title),
      ...(smallImage ? { smallImage, smallText: cleanText(art.smallText || name) } : {}),
    } : null,
    buttons,
    source: report.activityId || report.source || 'unknown',
  };
}
