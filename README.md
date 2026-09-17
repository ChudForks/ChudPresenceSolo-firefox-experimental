# ChudPresence Solo — Firefox Experimental

This is an independent Firefox fork of ChudPresence Solo. The original Chromium
repository has not been changed. It detects playback on YouTube, YouTube Music,
Crunchyroll, 67Movies, Twitch, and Kick, previews that activity in its popup, and
can experimentally publish it to Discord.

> Discord's Headless Sessions API is undocumented and may change or stop working.
> This build uses Discord OAuth with PKCE and never requests an account token.

## Load in Firefox

1. Run `npm run build`, or use the unpacked `extension` directory while developing.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose `extension/manifest.json`.
4. Open the add-on's panel. In Settings, copy the **Register Firefox callback**
   value shown under Discord connection.
5. In the Discord Developer Portal for client ID `1549066134706323548`, add that
   exact value to the application's OAuth2 Redirects and ensure **Public Client**
   is enabled. This is a one-time developer-portal configuration step; the fork
   does not modify the existing Chromium redirect or original extension.
6. Select **Connect**, then play something on a supported site.

Firefox derives the callback from the add-on at runtime via
`identity.getRedirectURL()`. The manifest pins this experimental add-on ID, so the
callback remains stable during temporary-install testing. Do not reuse the
Chromium `chromiumapp.org` callback from the original project.

The generated `.xpi` is unsigned and is intended for development/testing. Firefox
normally removes temporary add-ons at restart; install a signed XPI for persistent
use.

## Firefox-specific behavior

Firefox does not provide Chrome's offscreen-document API. The fork therefore does
not schedule best-effort deletion of a Discord Headless Session when Firefox is
force-closed. Normal disconnects and playback stops still clear the session.

Its Manifest V3 background is a Firefox module background script, so Firefox runs
the persistent background page. This fork requires Firefox 142 or later.

## Privacy and data transmission

ChudPresence Solo reads playback metadata only on the supported services. After a
user explicitly connects Discord and leaves sharing enabled, it sends the current
service, media title, creator or artist, playback state, optional artwork URL, and
optional link to Discord to publish the requested presence. Discord OAuth tokens
and extension settings are stored in Firefox's extension storage. They are never
exposed to page scripts or sent to the supported streaming services.

The 67Movies integration also asks The Movie Database (TMDB) for metadata using
the movie or TV identifier in the current page URL. No analytics, advertising,
sale of data, or unrelated tracking is included. Disable the extension or a
specific service to stop sharing; disabling 67Movies also stops its TMDB metadata
lookups. Use **Disconnect** to delete the active Discord session and revoke the
stored Discord authorization before uninstalling.

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## Development

Requirements: Node.js 18 or newer.

```bash
npm run check
npm test
npm run build
```

`npm run build` writes an unpacked directory and unsigned `.xpi` package to
`dist/`. Edit `extension/` directly during development, then reload the temporary
add-on from `about:debugging`.
