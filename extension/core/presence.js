import { EXTENSION_NAME } from './branding.js';

const MAX_TEXT_LENGTH = 128;

const SOURCE_LABELS = Object.freeze({
  crunchyroll: 'Crunchyroll',
  movies67: '67Movies',
  twitch: 'Twitch',
  kick: 'Kick',
  youtube: 'YouTube',
});

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function sourceLabel(track) {
  return track?.activityName || SOURCE_LABELS[track?.source] || EXTENSION_NAME;
}

function activityType(track) {
  return track?.kind === 'song' ? 'listening' : 'watching';
}

function timestamps(track, nowMs) {
  if (!track?.playing) return null;

  const position = Math.max(0, Number(track.position) || 0);
  const now = Math.floor(nowMs / 1000);
  if (track.live || track.kind === 'live') {
    return { start: now - Math.floor(position) };
  }

  const duration = Math.max(0, Number(track.duration) || 0);
  if (!duration || position >= duration) return null;
  return {
    start: now - Math.floor(position),
    end: now + Math.ceil(duration - position),
  };
}

function withMarkers(value, markers, fallback) {
  const suffix = markers.length ? ` • ${markers.join(' • ')}` : '';
  const text = cleanText(value || fallback, MAX_TEXT_LENGTH - suffix.length);
  return `${text}${suffix}`;
}

function withPlaybackState(value, track, fallback) {
  return withMarkers(value, track?.playing === false ? ['Paused'] : [], fallback);
}

function siteUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return '';
  return `${new URL(safe).origin}/`;
}

function layoutFor(track) {
  const provider = sourceLabel(track);
  const activityUrl = safeUrl(track.url);
  const channelUrl = safeUrl(track.channelUrl);

  if (track.source === 'youtube') {
    const live = track.live || track.kind === 'live';
    const creator = cleanText(track.artist || provider);
    return {
      details: cleanText(track.title),
      state: withMarkers(
        creator,
        [live && 'Live', !track.playing && 'Paused'].filter(Boolean),
        provider,
      ),
      largeText: cleanText(track.title || provider),
      buttons: [
        activityUrl && {
          label: track.kind === 'short' ? 'Watch Short' : 'Watch on YouTube',
          url: activityUrl,
        },
        channelUrl && channelUrl !== activityUrl && { label: 'View channel', url: channelUrl },
      ],
      statusFields: { app: 'name', creator: 'state', video: 'details' },
    };
  }

  if (track.source === 'crunchyroll') {
    const movie = track.kind === 'movie';
    const episodeTitle = cleanText(track.title);
    const series = cleanText(track.artist || episodeTitle || provider);
    return {
      details: movie ? episodeTitle : series,
      state: withPlaybackState(movie ? provider : track.album || episodeTitle, track, provider),
      largeText: movie ? episodeTitle : episodeTitle || track.album || provider,
      buttons: Array.isArray(track.buttons) && track.buttons.length
        ? track.buttons
        : [
            activityUrl && {
              label: movie ? 'Watch movie' : 'Watch on Crunchyroll',
              url: activityUrl,
            },
            !movie && channelUrl && channelUrl !== activityUrl && { label: 'View series', url: channelUrl },
          ],
      statusFields: { app: 'name', artist: 'details', track: 'state', series: 'details', episode: 'state' },
    };
  }

  if (track.source === 'movies67') {
    const movie = track.kind === 'movie';
    const title = cleanText(track.title);
    const series = cleanText(track.artist || title || provider);
    return {
      details: movie ? title : series,
      state: withPlaybackState(movie ? provider : title, track, provider),
      largeText: cleanText(movie ? title : [track.album, title].filter(Boolean).join(' • ') || provider),
      buttons: [
        activityUrl && {
          label: movie ? 'Watch movie' : 'Watch on 67Movies',
          url: activityUrl,
        },
        activityUrl && { label: 'Open 67Movies', url: siteUrl(activityUrl) },
      ],
      statusFields: { app: 'name', series: 'details', episode: 'state' },
    };
  }

  if (track.source === 'twitch') {
    const streamer = cleanText(track.artist || provider);
    const live = track.live || track.kind === 'live';
    return {
      details: cleanText(track.title),
      state: withMarkers(
        streamer,
        [live && 'Live', !track.playing && 'Paused'].filter(Boolean),
        provider,
      ),
      largeText: cleanText(track.title || provider),
      buttons: [
        activityUrl && { label: 'Watch on Twitch', url: activityUrl },
        channelUrl && channelUrl !== activityUrl && { label: 'Visit channel', url: channelUrl },
      ],
      statusFields: { app: 'name', streamer: 'state', stream: 'details' },
    };
  }

  if (track.source === 'kick') {
    const streamer = cleanText(track.artist || provider);
    const live = track.live || track.kind === 'live';
    return {
      details: cleanText(track.title),
      state: withMarkers(
        streamer,
        [live && 'Live', !track.playing && 'Paused'].filter(Boolean),
        provider,
      ),
      largeText: cleanText(track.title || provider),
      buttons: [
        activityUrl && { label: 'Watch on Kick', url: activityUrl },
        channelUrl && channelUrl !== activityUrl && { label: 'Visit channel', url: channelUrl },
      ],
      statusFields: { app: 'name', streamer: 'state', stream: 'details' },
    };
  }

  return {
    details: cleanText(track.details || track.title),
    state: withPlaybackState(track.state || track.artist || track.album, track, provider),
    largeText: cleanText(track.album || track.details || provider),
    buttons: Array.isArray(track.buttons) && track.buttons.length
      ? track.buttons
      : [activityUrl && { label: 'Open', url: activityUrl }],
    statusFields: { app: 'name', artist: 'state', track: 'details' },
  };
}

/**
 * Converts a provider-neutral track into a transport-neutral Discord presence
 * intent. A native Social SDK, Embedded App, or another supported connector can
 * translate this object without coupling itself to page scraping code.
 */
export function createPresenceIntent(track, nowMs = Date.now(), settings = {}) {
  if (!track?.title || track.idle || track.ad) return null;

  const provider = sourceLabel(track);
  const layout = layoutFor(track);
  const artwork = settings.showArtwork === false ? '' : safeUrl(track.artwork);
  const statusDisplayType = layout.statusFields[settings.statusDisplay] || 'name';

  return {
    name: provider,
    type: activityType(track),
    details: layout.details,
    state: layout.state,
    statusDisplayType,
    timestamps: settings.showTimestamps === false ? null : timestamps(track, nowMs),
    assets: artwork ? { largeImage: artwork, largeText: cleanText(layout.largeText) } : null,
    buttons: settings.showButtons === false ? [] : layout.buttons.filter(Boolean).slice(0, 2),
    source: track.source || 'unknown',
  };
}
