# Architecture

ChudPresence Solo is one Manifest V3 Chromium extension. It has no localhost
server, native process, installer, autostart entry, or bundled runtime.

## Layered flow

The project follows the shape of the proposed PreMiD-style pipeline while
keeping detection separate from Discord delivery:

```text
YouTube / YouTube Music / Crunchyroll / 67Movies / Twitch / Kick
                         |
                         v
              provider content scripts
                         |
                  TRACK_UPDATE message
                         |
                         v
           activity broker (select one tab)
                    /             \
                   v               v
             popup preview   presence intent mapper
                                      |
                                      v
                              publisher transport port
                                      |
                         +------------+------------+
                         |                         |
                         v                         v
                  preview publisher       supported Discord
                    (current)             connector (future)
```

This gives the extension a stable internal contract that resembles:

```text
site -> extension activity -> Discord-ready activity -> connection -> Rich Presence
```

It does **not** model OAuth tokens as a presence transport. Authentication and
delivery are separate concerns.

## Experimental extension-only Discord path

Discord does not document a supported public REST endpoint for browser extensions
to set a user's Rich Presence. It does, however, currently expose an undocumented
Headless Sessions endpoint that accepts OAuth access tokens carrying the
`sdk.social_layer_presence` scope. ChudPresence Solo uses that endpoint as an
explicitly experimental transport.

Discord currently supports off-platform Rich Presence through its native Social
SDK. Its direct RPC mode requires a running Discord client and explicitly does
not support web clients. A Manifest V3 extension cannot load the native Social
SDK or open Discord's desktop IPC socket. The Embedded App SDK is for an Activity
running inside Discord, not an arbitrary extension page.

For a supported production publisher, the documented product choices remain:

1. Allow a small native host using Discord's Social SDK. This is the direct and
   supported Rich Presence route, but it is a companion component.
2. Turn ChudPresence Solo into a Discord Activity using the Embedded App SDK. This is
   browser technology, but users must run the Activity inside Discord and a
   secure relay would be needed to receive browser-extension events.
3. Keep ChudPresence Solo extension-only and fall back to local preview whenever
   its experimental Headless Sessions transport is unavailable.

A bot or ordinary OAuth-backed web service is not a fourth option: it can update
the bot's presence, not the authenticated user's presence.

## Module ownership

- `extension/content.js`, `youtube.js`, `crunchyroll.js`, `movies67.js`, `twitch.js`, and `kick.js` are
  provider adapters. They observe a page and emit normalized tracks.
- `extension/core/activity.js` selects one reportable track across browser tabs.
- `extension/core/presence.js` converts that track to a transport-neutral,
  Discord-shaped presence intent. It owns text limits, safe external URLs,
  timers, artwork, and buttons.
- `extension/background.js` owns browser lifecycle, settings, and orchestration.
  It selects the active service profile before handing an intent to the
  publisher.
- `extension/discord/auth.js` owns OAuth PKCE, refresh, revocation, and isolated
  token storage.
- `extension/discord/presence.js` owns Headless Sessions, renewal, clearing, and
  transport status.
- `extension/discord/activity-builder.js` converts the transport-neutral intent
  to Discord's headless activity payload.
- `extension/platform/presence-publisher.js` remains the delivery boundary. A
  future supported connector can replace this layer without changing adapters.
- `extension/popup.*` renders detected activity, publisher status, and the
  in-panel settings experience. `core/settings.js` owns defaults,
  legacy-global-preference migration, presence preferences, and provider
  filtering. `config.js` owns the fixed Discord application identities and
  OAuth redirect URI. Paused-media visibility and
  member-list status text are selected independently for each provider.

Provider tracks may contain `source`, `kind`, `title`, `artist`, `album`,
`artwork`, `url`, `channelUrl`, `playing`, `idle`, `ad`, `live`, `position`, and
`duration`. Consumers tolerate missing optional fields.

The publisher accepts a presence intent plus the active service's fixed Discord
application ID, or `null` to clear the presence. The OAuth application owns the
single shared Discord login; service IDs identify the displayed activity. The
publisher returns a delivery status with `id`, `available`,
`state`, and `message` so UI code never has to know which transport is installed.

## Reliability boundary

The extension explicitly clears activity during normal pause, disable, and logout
flows. While a Headless Session is active, an extension-owned offscreen document
also holds a Chrome `fetchLater()` request containing the current session and
access tokens in memory. Chrome activates that request when the document is
destroyed during a normal browser shutdown. Credentials never enter a provider
content script or page context. If deferred fetch is unavailable, the browser is
killed, or the cleanup request cannot reach Discord, Discord's approximately
20-minute Headless Session expiry remains the cleanup fallback. A ten-minute
extension alarm renews an active session and replaces the deferred cleanup request
with fresh credentials while the browser remains available.
