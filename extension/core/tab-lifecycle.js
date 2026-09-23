// A URL-only tab update can be a History API change in the same document.
// Retire Activity documents only when Firefox starts loading a document or
// discards the tab. The Activity's SPA listener handles same-document URLs.
export function shouldInvalidateActivityTab(changeInfo) {
  return changeInfo?.discarded === true || changeInfo?.status === 'loading';
}
