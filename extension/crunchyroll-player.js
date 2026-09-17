(() => {
  const SOURCE = 'chudpresence-solo-crunchyroll-player';

  function findVideo() {
    return (
      document.querySelector('#player-container video') ||
      document.querySelector('video[id^="bitmovinplayer-video"]') ||
      document.querySelector('#player0') ||
      document.querySelector('#player_html5_api') ||
      document.querySelector('#bitmovinplayer-video-null') ||
      document.querySelector('video')
    );
  }

  function snapshot() {
    const video = findVideo();
    if (!video) return null;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    return {
      source: SOURCE,
      hasVideo: true,
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
    };
  }

  function post() {
    const data = snapshot();
    if (!data) return;
    try {
      window.postMessage(data, '*');
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(data, '*');
      }
    } catch {
      // Cross-origin parent, or the document was replaced.
    }
  }

  setInterval(post, 1000);
  document.addEventListener('play', post, true);
  document.addEventListener('pause', (event) => {
    if (event.target?.paused === false) return;
    post();
  }, true);
  document.addEventListener('loadedmetadata', post, true);
  document.addEventListener('seeked', post, true);
  post();
})();
