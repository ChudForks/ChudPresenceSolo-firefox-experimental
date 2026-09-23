function normalizeDocumentId(documentId) {
  return typeof documentId === 'string' && documentId ? documentId : null;
}

/**
 * Keeps each tab's report tied to the document that produced it. A Chromium tab
 * ID survives navigation, while its document ID does not.
 */
export class ActivityRegistry {
  constructor() {
    this.entries = new Map();
  }

  update(tabId, documentId, track) {
    if (typeof tabId !== 'number') return false;
    this.entries.set(tabId, {
      documentId: normalizeDocumentId(documentId),
      track: track || { idle: true },
    });
    return true;
  }

  heartbeat(tabId, documentId, track = null) {
    if (track && typeof tabId === 'number') return this.update(tabId, documentId, track);
    if (typeof tabId !== 'number' || this.entries.has(tabId)) return false;
    return this.update(tabId, documentId, { idle: true });
  }

  clearDocument(tabId, documentId) {
    const entry = this.entries.get(tabId);
    if (!entry) return false;

    const owner = entry.documentId;
    const closing = normalizeDocumentId(documentId);
    if (owner && closing && owner !== closing) return false;

    this.entries.delete(tabId);
    return true;
  }

  clearActivity(activityId, tabId = null, documentId = null) {
    let cleared = false;
    for (const [currentTabId, entry] of this.entries) {
      if (typeof tabId === 'number' && currentTabId !== tabId) continue;
      if (entry.track?.activityId !== activityId) continue;
      const owner = entry.documentId;
      const closing = normalizeDocumentId(documentId);
      if (owner && closing && owner !== closing) continue;
      this.entries.delete(currentTabId);
      cleared = true;
    }
    return cleared;
  }

  clearTab(tabId) {
    return this.entries.delete(tabId);
  }

  has(tabId) {
    return this.entries.has(tabId);
  }

  tracks() {
    return new Map([...this.entries].map(([tabId, entry]) => [tabId, entry.track]));
  }
}
