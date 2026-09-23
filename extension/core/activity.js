export function isReportable(track) {
  if (!track) return false;
  if (track.media && track.playback) {
    return track.visibility === 'normal' && Boolean(track.media.title);
  }
  return Boolean(!track.idle && !track.ad && track.title);
}

export function isPlaying(track) {
  return track?.playback ? track.playback.state === 'playing' : Boolean(track?.playing);
}

export function selectActivity(tracksByTab, activeTabId = null) {
  const entries = [...tracksByTab.entries()].filter(([, track]) => isReportable(track));
  const playing = entries.filter(([, track]) => isPlaying(track));
  const candidates = playing.length ? playing : entries;
  if (!candidates.length) return { tabId: null, track: null };

  const sticky = candidates.find(([tabId]) => tabId === activeTabId);
  const [tabId, track] = sticky || candidates[candidates.length - 1];
  return { tabId, track };
}
