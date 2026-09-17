// Firefox does not implement Chrome's offscreen-document API, which the
// Chromium build uses solely to arm fetchLater-based shutdown cleanup. Presence
// is still deleted on normal disconnect or when playback stops; this experiment
// intentionally omits best-effort cleanup when Firefox itself is terminated.
export async function armShutdownCleanup() {
  return false;
}

export async function disarmShutdownCleanup() {
  // No Firefox shutdown hook is registered.
}
