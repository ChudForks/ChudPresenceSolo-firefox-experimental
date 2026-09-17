# AMO listing and reviewer notes

Copy the following text into the corresponding addons.mozilla.org fields. Replace
the support contact with your own before submission, and publish `PRIVACY.md` at
a stable public URL for the listing's Privacy Policy field.

## Summary

Share supported YouTube, YouTube Music, Crunchyroll, Twitch, Kick, and 67Movies
playback activity to Discord. You control sharing globally and per service.

## Description

ChudPresence Solo for Firefox displays the playback activity from supported
services in Discord after you connect your Discord account.

Choose which services may share, then control whether Discord displays artwork,
playback progress, activity links, and paused media. The add-on only reads
playback metadata on the supported services. It does not change search, new-tab,
homepage, or streaming-site content, and it has no ads or analytics.

### What is sent and why

After you choose **Connect** and enable sharing, the add-on sends Discord the
current service, media title, creator or artist, playback state, optional artwork
URL, optional progress timestamps, and optional media link. Discord uses this
information to display your requested Rich Presence.

When enabled, the 67Movies integration sends the movie or TV identifier in the
current page URL to TMDB only to retrieve matching title, artwork, and runtime
metadata. Disable the 67Movies service to stop those lookups. No playback
information is sent to the supported streaming sites.

Disable sharing globally, disable a service, or select **Disconnect** at any time.
Disconnect clears the active Discord session and revokes the stored Discord
authorization.

## Privacy policy

Use the full text in `PRIVACY.md` for the AMO privacy-policy field and host that
same document at a stable public URL.

## Reviewer notes

- The extension uses Manifest V3 and Firefox 142 or later.
- It loads readable, bundled JavaScript only; it contains no remote code,
  `eval`, code generation, analytics, advertising, or native messaging.
- Content scripts are limited to the services listed in `manifest.json`. They
  collect only playback metadata needed to create Discord presence.
- `identity` implements user-initiated Discord OAuth authorization-code flow
  with PKCE. OAuth access and refresh tokens remain in extension storage.
- Network destinations are Discord for OAuth and presence updates, and TMDB for
  67Movies title, artwork, and runtime lookups. The 67Movies request uses only
  the current media identifier.
- To test: open the toolbar popup, open Settings, choose Connect, complete
  Discord OAuth, and start a supported video or track. Disconnect clears the
  session and revokes authorization.
- Source is readable and reproducibly built with Node.js 18+ using `npm run
  build`. Upload this source tree as the AMO source package together with the
  generated XPI.
