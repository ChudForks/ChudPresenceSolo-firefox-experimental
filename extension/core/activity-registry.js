function normalizeDocumentId(documentId) {
  return typeof documentId === 'string' && documentId ? documentId : null;
}

function normalizeFrameId(frameId) {
  return Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
}

/**
 * Keeps each report tied to the tab, frame, and document that produced it.
 * When a frame clears, the most recently updated report from another live
 * frame can become current again.
 */
export class ActivityRegistry {
  constructor() {
    this.entries = new Map();
    this.sequence = 0;
  }

  update(tabId, documentId, track, frameId = 0) {
    if (typeof tabId !== 'number') return false;
    if (!this.entries.has(tabId)) this.entries.set(tabId, new Map());
    this.entries.get(tabId).set(normalizeFrameId(frameId), {
      documentId: normalizeDocumentId(documentId),
      frameId: normalizeFrameId(frameId),
      track: track || { idle: true },
      sequence: ++this.sequence,
    });
    return true;
  }

  heartbeat(tabId, documentId, track = null, frameId = 0) {
    if (track && typeof tabId === 'number') return this.update(tabId, documentId, track, frameId);
    if (typeof tabId !== 'number' || this.entries.has(tabId)) return false;
    return this.update(tabId, documentId, { idle: true }, frameId);
  }

  clearDocument(tabId, documentId, frameId = null) {
    const frames = this.entries.get(tabId);
    if (!frames) return false;
    const closing = normalizeDocumentId(documentId);
    const targets = Number.isInteger(frameId)
      ? [[frameId, frames.get(frameId)]]
      : [...frames.entries()].filter(([, entry]) => !closing || entry.documentId === closing);
    let cleared = false;
    for (const [currentFrameId, entry] of targets) {
      if (!entry) continue;
      if (entry.documentId && closing && entry.documentId !== closing) continue;
      frames.delete(currentFrameId);
      cleared = true;
    }
    if (!frames.size) this.entries.delete(tabId);
    return cleared;
  }

  clearActivity(activityId, tabId = null, documentId = null, frameId = null) {
    let cleared = false;
    for (const [currentTabId, frames] of this.entries) {
      if (typeof tabId === 'number' && currentTabId !== tabId) continue;
      for (const [currentFrameId, entry] of frames) {
        if (Number.isInteger(frameId) && currentFrameId !== frameId) continue;
        if (entry.track?.activityId !== activityId) continue;
        const owner = entry.documentId;
        const closing = normalizeDocumentId(documentId);
        if (owner && closing && owner !== closing) continue;
        frames.delete(currentFrameId);
        cleared = true;
      }
      if (!frames.size) this.entries.delete(currentTabId);
    }
    return cleared;
  }

  clearTab(tabId) {
    return this.entries.delete(tabId);
  }

  has(tabId) {
    return Boolean(this.entries.get(tabId)?.size);
  }

  tracks() {
    const tracks = new Map();
    for (const [tabId, frames] of this.entries) {
      const current = [...frames.values()].sort((left, right) => right.sequence - left.sequence)[0];
      if (current) tracks.set(tabId, current.track);
    }
    return tracks;
  }
}
