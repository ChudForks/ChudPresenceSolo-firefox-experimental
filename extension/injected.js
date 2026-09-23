(() => {
  const SOURCE = 'chudpresence-solo';

  const videoIdFromHref = (href) => {
    if (!href) return '';
    try {
      return new URL(href, location.origin).searchParams.get('v') || '';
    } catch {
      const match = String(href).match(/[?&]v=([\w-]{11})/);
      return match ? match[1] : '';
    }
  };

  const videoIdFromThumb = (src) => {
    const match = String(src || '').match(/\/vi(?:_webp)?\/([\w-]{11})\//);
    return match ? match[1] : '';
  };

  const videoIdFromPath = () => {
    const fromUrl = new URLSearchParams(location.search).get('v');
    if (fromUrl) return fromUrl;
    const path = location.pathname || '';
    const match = path.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return match ? match[1] : '';
  };

  const playerEl = () =>
    document.querySelector('#movie_player, #shorts-player, .html5-video-player');

  // videoDetails.isLiveContent is true for old livestream VODs too.
  // Only isLive / isLiveNow mean the broadcast is happening right now.
  const currentlyLive = (player, videoData, duration) => {
    try {
      const response = player.getPlayerResponse?.() || player.getPresentingPlayerResponse?.();
      const details = response?.videoDetails;
      const sameVideo =
        !details?.videoId ||
        !videoData?.video_id ||
        details.videoId === videoData.video_id ||
        details.videoId === videoData.videoId;
      if (details && sameVideo) {
        if (details.isLive === true) return true;
        const liveNow = response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow;
        return liveNow === true;
      }
    } catch {
      // getPlayerResponse is missing on some player builds.
    }
    if (videoData?.isLive === true || videoData?.is_live === true) return true;
    return duration === Infinity;
  };

  const playerSnapshot = () => {
    const player = playerEl();
    const data = { ad: false, isLive: false, playerState: undefined, currentTime: undefined, duration: undefined, videoId: '', title: '', author: '' };
    if (!player) return data;

    try {
      data.ad = Boolean(
        player.classList?.contains('ad-showing') ||
          player.classList?.contains('ad-interrupting') ||
          player.querySelector?.('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout'),
      );
    } catch {
      // Player node can be replaced mid-read.
    }

    let videoData = null;
    try {
      videoData = player.getVideoData?.() || null;
      if (videoData && typeof videoData === 'object') {
        data.videoId = videoData.video_id || videoData.videoId || '';
        data.title = videoData.title || '';
        data.author = videoData.author || videoData.ownerName || '';
      }
    } catch {
      // Player API is not always ready.
    }

    try {
      if (typeof player.getCurrentTime === 'function') {
        const value = player.getCurrentTime();
        if (Number.isFinite(value)) data.currentTime = value;
      }
      if (typeof player.getDuration === 'function') {
        const value = player.getDuration();
        if (Number.isFinite(value) && value > 0) data.duration = value;
      }
      if (typeof player.getPlayerState === 'function') {
        data.playerState = player.getPlayerState();
      }
    } catch {
      // Internal player methods change between YouTube versions.
    }

    data.isLive = currentlyLive(player, videoData, data.duration);

    return data;
  };

  const currentVideoId = () => {
    const fromPath = videoIdFromPath();
    if (fromPath) return fromPath;

    const snapshot = playerSnapshot();
    if (snapshot.videoId) return snapshot.videoId;

    const flexy = document.querySelector('ytd-watch-flexy');
    const fromFlexy = flexy?.getAttribute?.('video-id');
    if (fromFlexy) return fromFlexy;

    const hrefs = [
      document.querySelector('link[rel="canonical"]')?.href,
      document.querySelector('a.ytp-title-link')?.href,
    ];
    for (const href of hrefs) {
      const id = videoIdFromHref(href);
      if (id) return id;
    }

    const thumbs = document.querySelectorAll(
      '#movie_player .ytp-cued-thumbnail-overlay-image, ytd-video-owner-renderer img',
    );
    for (const img of thumbs) {
      const id = videoIdFromThumb(img.currentSrc || img.src || img.style?.backgroundImage);
      if (id) return id;
    }

    return '';
  };

  let unloading = false;
  const post = () => {
    if (unloading) return;
    try {
      const session = navigator.mediaSession;
      const metadata = session?.metadata || null;
      const player = playerSnapshot();
      const videoId = currentVideoId() || player.videoId || '';
      window.postMessage(
        {
          source: SOURCE,
          playbackState: session?.playbackState || 'none',
          videoId,
          ad: player.ad,
          player,
          metadata: metadata
            ? {
                title: metadata.title || '',
                artist: metadata.artist || '',
                album: metadata.album || '',
                artwork: Array.from(metadata.artwork || []).map((item) => ({
                  src: item.src,
                  sizes: item.sizes || '',
                })),
              }
            : null,
        },
        '*',
      );
    } catch {
      // YouTube can replace the document while injecting.
    }
  };

  window.addEventListener('beforeunload', () => {
    unloading = true;
  });
  window.addEventListener('pagehide', () => {
    unloading = true;
  });
  window.addEventListener('pageshow', () => {
    unloading = false;
    post();
  });

  setInterval(post, 1000);
  document.addEventListener('play', post, true);
  document.addEventListener('pause', (event) => {
    // Closing the tab pauses the <video> as it tears down. That snapshot
    // would otherwise mark a still-playing tab as paused.
    if (unloading || event.target?.paused === false) return;
    post();
  }, true);
  document.addEventListener('loadedmetadata', post, true);
  document.addEventListener('yt-navigate-finish', post, true);
  document.addEventListener('yt-page-data-updated', post, true);
})();
