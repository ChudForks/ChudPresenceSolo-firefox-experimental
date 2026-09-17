export function isReportable(track) {
  return Boolean(track && !track.idle && !track.ad && track.title);
}

export function selectActivity(tracksByTab, activeTabId = null) {
  const entries = [...tracksByTab.entries()].filter(([, track]) => isReportable(track));
  const playing = entries.filter(([, track]) => track.playing);
  const candidates = playing.length ? playing : entries;
  if (!candidates.length) return { tabId: null, track: null };

  const sticky = candidates.find(([tabId]) => tabId === activeTabId);
  const [tabId, track] = sticky || candidates[candidates.length - 1];
  return { tabId, track };
}
