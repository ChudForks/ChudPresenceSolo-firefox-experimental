import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresenceIntent } from '../extension/core/presence.js';
import { normalizeActivityReport } from '../extension/core/activity-validator.js';

function intentWithoutSource(intent) {
  const { source, ...formatting } = intent;
  return formatting;
}

test('formats a song Activity through the generic presence path', () => {
  const intent = createPresenceIntent({
    source: 'sample-activity',
    activityName: 'Sample Music Activity',
    kind: 'song',
    title: 'A Song',
    artist: 'An Artist',
    album: 'An Album',
    artwork: 'https://example.com/art.jpg',
    url: 'https://music.example.com/watch?id=abcdefghijk',
    playing: true,
    position: 30,
    duration: 210,
  }, 1_000_000);

  assert.deepEqual(intent, {
    name: 'Sample Music Activity',
    type: 'listening',
    details: 'A Song',
    state: 'An Artist',
    statusDisplayType: 'name',
    timestamps: { start: 970, end: 1180 },
    assets: { largeImage: 'https://example.com/art.jpg', largeText: 'An Album' },
    buttons: [
      { label: 'Open', url: 'https://music.example.com/watch?id=abcdefghijk' },
    ],
    source: 'sample-activity',
  });
});

test('formats normalized Activity reports independently of their registered Activity ID', () => {
  const report = normalizeActivityReport({
    kind: 'episode',
    media: { title: 'The Adventure Begins', series: 'Example Series', season: 1, episode: 3 },
    playback: { state: 'playing', position: 120, duration: 1440 },
    artwork: { large: 'https://example.com/episode.jpg', largeText: 'The Adventure Begins' },
    buttons: [{ label: 'Watch', url: 'https://watch.example.com/episode/3' }],
  });
  const first = createPresenceIntent({
    ...report, activityId: 'crunchyroll', activityName: 'Example Activity', source: 'activity',
  }, 1_000_000);
  const second = createPresenceIntent({
    ...report, activityId: 'another-site', activityName: 'Example Activity', source: 'activity',
  }, 1_000_000);

  assert.deepEqual(intentWithoutSource(first), intentWithoutSource(second));
  assert.equal(first.type, 'watching');
  assert.equal(first.details, 'Example Series');
  assert.equal(first.state, 'The Adventure Begins');
  assert.deepEqual(first.timestamps, { start: 880, end: 2320 });
  assert.deepEqual(first.buttons, [{ label: 'Watch', url: 'https://watch.example.com/episode/3' }]);
});

test('uses generic song, movie, and stream report semantics', () => {
  const song = createPresenceIntent({
    ...normalizeActivityReport({ kind: 'song', media: { title: 'Song', artist: 'Artist', album: 'Album' } }),
    activityName: 'Music Activity',
  });
  assert.equal(song.type, 'listening');
  assert.equal(song.details, 'Song');
  assert.equal(song.state, 'Artist');

  const movie = createPresenceIntent({
    ...normalizeActivityReport({ kind: 'movie', media: { title: 'Movie' } }),
    activityName: 'Film Activity',
  });
  assert.equal(movie.type, 'watching');
  assert.equal(movie.details, 'Movie');

  const stream = createPresenceIntent({
    ...normalizeActivityReport({
      kind: 'stream', media: { title: 'Live show', creator: 'Creator' },
      buttons: [{ label: 'Watch', url: 'https://stream.example.com/live' }],
      playback: { live: true, position: 30 },
    }),
    activityName: 'Stream Activity',
  }, 1_000_000);
  assert.equal(stream.type, 'streaming');
  assert.equal(stream.streamUrl, 'https://stream.example.com/live');
  assert.equal(stream.state, 'Creator • Live');
});

test('applies installed Activity status, artwork, timer, and button preferences', () => {
  const intent = createPresenceIntent({
    source: 'sample-activity',
    activityName: 'Sample Music Activity',
    kind: 'song',
    title: 'A Song',
    artist: 'An Artist',
    artwork: 'https://example.com/art.jpg',
    url: 'https://music.example.com/watch?id=abcdefghijk',
    playing: true,
    position: 30,
    duration: 210,
  }, 1_000_000, {
    statusDisplay: 'track',
    showArtwork: false,
    showTimestamps: false,
    showButtons: false,
  });

  assert.equal(intent.statusDisplayType, 'details');
  assert.equal(intent.assets, null);
  assert.equal(intent.timestamps, null);
  assert.deepEqual(intent.buttons, []);
});

test('omits timers while paused and rejects unsafe URLs', () => {
  const intent = createPresenceIntent({
    kind: 'episode',
    media: { title: 'Episode title', series: 'Series title' },
    playback: { state: 'paused', position: 0, duration: 0, live: false, rate: 1 },
    display: { details: 'Series title', state: 'Episode title', statusDisplay: 'details' },
    artwork: { large: 'http://example.com/art.jpg' },
    buttons: [{ label: 'Unsafe', url: 'http://example.com/watch' }],
    visibility: 'normal',
    activityName: 'Crunchyroll',
  });

  assert.equal(intent.timestamps, null);
  assert.equal(intent.assets, null);
  assert.deepEqual(intent.buttons, []);
  assert.equal(intent.details, 'Series title');
  assert.equal(intent.state, 'Episode title • Paused');
});

test('uses YouTube layouts for videos, Shorts, and live streams', () => {
  const short = createPresenceIntent({
    activityName: 'YouTube',
    presenceKind: 'video',
    source: 'youtube',
    kind: 'short',
    title: 'A Short',
    artist: 'A Creator',
    artwork: 'https://example.com/short.jpg',
    url: 'https://www.youtube.com/shorts/abcdefghijk',
    channelUrl: 'https://www.youtube.com/@creator',
    display: {
      details: 'A Short', state: 'A Creator', largeText: 'A Short',
      statusFields: { app: 'name', creator: 'state', video: 'details' },
    },
    buttons: [
      { label: 'Watch Short', url: 'https://www.youtube.com/shorts/abcdefghijk' },
      { label: 'View channel', url: 'https://www.youtube.com/@creator' },
    ],
    playing: true,
    position: 5,
    duration: 20,
  }, 1_000_000, { statusDisplay: 'creator' });

  assert.equal(short.name, 'YouTube');
  assert.equal(short.details, 'A Short');
  assert.equal(short.state, 'A Creator');
  assert.equal(short.statusDisplayType, 'state');
  assert.deepEqual(short.buttons, [
    { label: 'Watch Short', url: 'https://www.youtube.com/shorts/abcdefghijk' },
    { label: 'View channel', url: 'https://www.youtube.com/@creator' },
  ]);

  const live = createPresenceIntent({
    activityName: 'YouTube',
    presenceKind: 'streaming',
    source: 'youtube',
    kind: 'live',
    live: true,
    title: 'Live now',
    artist: 'A Channel',
    playing: true,
    position: 90,
    display: {
      details: 'Live now', state: 'A Channel',
      statusFields: { app: 'name', creator: 'state', video: 'details' },
    },
  }, 1_000_000, { statusDisplay: 'video' });

  assert.equal(live.state, 'A Channel • Live');
  assert.equal(live.statusDisplayType, 'details');
  assert.deepEqual(live.timestamps, { start: 910 });
});

test('uses Activity-authored Crunchyroll display overrides without a provider branch', () => {
  const episode = createPresenceIntent({
    activityId: 'crunchyroll',
    activityName: 'Crunchyroll',
    ...normalizeActivityReport({
      kind: 'episode',
      media: { title: 'The Adventure Begins', series: 'Example Series', season: 1, episode: 3 },
      display: { details: 'Example Series', state: 'Season 1, Episode 3', statusDisplay: 'details' },
      artwork: { large: 'https://example.com/episode.jpg', largeText: 'The Adventure Begins' },
      buttons: [
        { label: 'Watch on Crunchyroll', url: 'https://www.crunchyroll.com/watch/ABC123' },
        { label: 'View series', url: 'https://www.crunchyroll.com/series/XYZ789' },
      ],
    }),
  }, 1_000_000);

  assert.equal(episode.details, 'Example Series');
  assert.equal(episode.state, 'Season 1, Episode 3');
  assert.equal(episode.assets.largeText, 'The Adventure Begins');
  assert.equal(episode.statusDisplayType, 'details');
  assert.deepEqual(episode.buttons, [
    { label: 'Watch on Crunchyroll', url: 'https://www.crunchyroll.com/watch/ABC123' },
    { label: 'View series', url: 'https://www.crunchyroll.com/series/XYZ789' },
  ]);

  const movie = createPresenceIntent({
    activityId: 'crunchyroll',
    activityName: 'Crunchyroll',
    ...normalizeActivityReport({
      kind: 'movie',
      media: { title: 'Example Movie' },
      buttons: [{ label: 'Watch movie', url: 'https://www.crunchyroll.com/watch/MOVIE123' }],
    }),
  });
  assert.equal(movie.details, 'Example Movie');
  assert.equal(movie.state, 'Crunchyroll');
  assert.deepEqual(movie.buttons, [
    { label: 'Watch movie', url: 'https://www.crunchyroll.com/watch/MOVIE123' },
  ]);
});

test('uses dedicated 67Movies episode and movie layouts', () => {
  const episode = createPresenceIntent({
    activityName: '67Movies',
    presenceKind: 'video',
    source: 'movies67',
    kind: 'episode',
    title: 'Episode title',
    artist: 'Series name',
    album: 'Season 2, Episode 4',
    artwork: 'https://image.tmdb.org/t/p/w500/still.jpg',
    url: 'https://67movies.st/watch/tv/123/2/4',
    playing: true,
    display: {
      details: 'Series name', state: 'Episode title',
      largeText: 'Season 2, Episode 4 • Episode title',
      statusFields: { app: 'name', series: 'details', episode: 'state' },
    },
    buttons: [
      { label: 'Watch on 67Movies', url: 'https://67movies.st/watch/tv/123/2/4' },
      { label: 'Open 67Movies', url: 'https://67movies.st/' },
    ],
  }, 1_000_000, { statusDisplay: 'episode' });

  assert.equal(episode.details, 'Series name');
  assert.equal(episode.state, 'Episode title');
  assert.equal(episode.assets.largeText, 'Season 2, Episode 4 • Episode title');
  assert.equal(episode.statusDisplayType, 'state');
  assert.deepEqual(episode.buttons, [
    { label: 'Watch on 67Movies', url: 'https://67movies.st/watch/tv/123/2/4' },
    { label: 'Open 67Movies', url: 'https://67movies.st/' },
  ]);

  const movie = createPresenceIntent({
    activityName: '67Movies',
    presenceKind: 'video',
    source: 'movies67',
    kind: 'movie',
    title: 'Movie title',
    url: 'https://67movies.st/watch/movie/456',
    playing: false,
    display: {
      details: 'Movie title', state: '67Movies', largeText: 'Movie title',
      statusFields: { app: 'name', series: 'details', episode: 'state' },
    },
    buttons: [
      { label: 'Watch movie', url: 'https://67movies.st/watch/movie/456' },
      { label: 'Open 67Movies', url: 'https://67movies.st/' },
    ],
  });
  assert.equal(movie.details, 'Movie title');
  assert.equal(movie.state, '67Movies • Paused');
  assert.deepEqual(movie.buttons, [
    { label: 'Watch movie', url: 'https://67movies.st/watch/movie/456' },
    { label: 'Open 67Movies', url: 'https://67movies.st/' },
  ]);
});

test('uses a dedicated Twitch stream layout', () => {
  const live = createPresenceIntent({
    activityName: 'Twitch',
    presenceKind: 'streaming',
    source: 'twitch',
    kind: 'live',
    live: true,
    title: 'Ranked with friends',
    artist: 'Streamer',
    artwork: 'https://static-cdn.jtvnw.net/preview.jpg',
    url: 'https://www.twitch.tv/streamer',
    channelUrl: 'https://www.twitch.tv/streamer',
    playing: true,
    position: 75,
    display: {
      details: 'Ranked with friends', state: 'Streamer', largeText: 'Ranked with friends',
      statusFields: { app: 'name', streamer: 'state', stream: 'details' },
    },
    buttons: [{ label: 'Watch on Twitch', url: 'https://www.twitch.tv/streamer' }],
  }, 1_000_000, { statusDisplay: 'streamer' });

  assert.equal(live.name, 'Twitch');
  assert.equal(live.state, 'Streamer • Live');
  assert.equal(live.statusDisplayType, 'state');
  assert.deepEqual(live.timestamps, { start: 925 });
  assert.deepEqual(live.buttons, [
    { label: 'Watch on Twitch', url: 'https://www.twitch.tv/streamer' },
  ]);
});

test('uses a dedicated Kick stream layout', () => {
  const vod = createPresenceIntent({
    activityName: 'Kick',
    presenceKind: 'video',
    source: 'kick',
    kind: 'video',
    title: 'A past broadcast',
    artist: 'Streamer',
    artwork: 'https://images.kick.com/video.jpg',
    url: 'https://kick.com/streamer/videos/01234567-89ab-cdef-0123-456789abcdef',
    channelUrl: 'https://kick.com/streamer',
    playing: true,
    position: 40,
    duration: 120,
    display: {
      details: 'A past broadcast', state: 'Streamer', largeText: 'A past broadcast',
      statusFields: { app: 'name', streamer: 'state', stream: 'details' },
    },
    buttons: [
      { label: 'Watch on Kick', url: 'https://kick.com/streamer/videos/01234567-89ab-cdef-0123-456789abcdef' },
      { label: 'Visit channel', url: 'https://kick.com/streamer' },
    ],
  }, 1_000_000, { statusDisplay: 'stream' });

  assert.equal(vod.name, 'Kick');
  assert.equal(vod.details, 'A past broadcast');
  assert.equal(vod.state, 'Streamer');
  assert.equal(vod.statusDisplayType, 'details');
  assert.deepEqual(vod.buttons, [
    { label: 'Watch on Kick', url: 'https://kick.com/streamer/videos/01234567-89ab-cdef-0123-456789abcdef' },
    { label: 'Visit channel', url: 'https://kick.com/streamer' },
  ]);
});

test('does not create presence for idle, ad, or untitled tracks', () => {
  assert.equal(createPresenceIntent(null), null);
  assert.equal(createPresenceIntent({ idle: true, title: 'Idle' }), null);
  assert.equal(createPresenceIntent({ ad: true, title: 'Ad' }), null);
  assert.equal(createPresenceIntent({ playing: true }), null);
});

test('honors presence detail preferences', () => {
  const intent = createPresenceIntent({
    source: 'youtube',
    title: 'Video',
    artwork: 'https://example.com/art.jpg',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    playing: true,
    position: 5,
    duration: 60,
  }, 1_000_000, {
    showArtwork: false,
    showTimestamps: false,
    showButtons: false,
  });

  assert.equal(intent.assets, null);
  assert.equal(intent.timestamps, null);
  assert.deepEqual(intent.buttons, []);
});
