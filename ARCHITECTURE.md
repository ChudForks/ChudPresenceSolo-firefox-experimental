# Architecture

ChudPresence Solo is one Firefox Manifest V3 extension. It has no localhost
server, native process, installer, autostart entry, or bundled runtime.

## Layered flow

The project follows the shape of the proposed PreMiD-style pipeline while
keeping detection separate from Discord delivery:

```text
Packaged providers                Installed Activities
(YouTube, 67Movies,               (YouTube Music,
 Twitch, Kick)                     Crunchyroll, community)
          |                                      | userScripts API
          | TRACK_UPDATE                         | ActivityReport v1
          +------------------+-------------------+
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
site -> packaged provider or installed Activity -> activity registry -> Discord-ready intent -> publisher
```

## Activity/core boundary

Installed Activities own site-specific DOM parsing, playback interpretation,
presentation choices, artwork selection, and action buttons. They report the
normalized ActivityReport v1 shape (`kind`, `media`, `playback`, `display`,
`artwork`, `buttons`, and `visibility`). `ActivityManager` verifies the
registered user-script world, attaches the trusted Activity identity, and
normalizes the report before it enters the activity registry.

The registry, selector, and presence mapper consume generic report concepts:
media kind, playback state, visibility, display text, artwork, and buttons.
They do not select layouts or formatting rules by Activity ID or website
source. Provider adapters that remain packaged emit the same generic display
descriptor and setting-key capabilities, so the core can apply shared
selection and formatting rules without knowing the provider.

The Activity identity is metadata for ownership, preferences, and diagnostics.
Activities cannot choose their identity in report data. Core code does not
expose Discord OAuth credentials, transport controls, extension storage, or
unrestricted browser APIs to Activities.

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

- `extension/youtube.js`, `movies67.js`, `twitch.js`, and `kick.js` are
  packaged provider adapters. YouTube Music and Crunchyroll are independently
  installed Activities under `ChudPresence-Activities/`.
- `extension/core/activity-validator.js` defines the latest Activity API version,
  lists the versions still supported by the runtime, and validates metadata,
  source size, and every normalized report. Catalog schema, metadata, and runtime
  API versions remain separate concepts.
- `extension/core/activity-manager.js` registers isolated Firefox user scripts,
  restores installations, and manages enable/disable/remove state.
- `extension/core/activity-repository.js` reads the GitHub catalog and verifies
  package hashes. `extension/core/activity-permissions.js` requests only the
  user-script permission and HTTPS origins needed for an installation.
- `extension/activities.*` provides Discover, Installed, Updates, and Developer
  views. `ChudPresence-Activities/` contains the publish-ready repository
  scaffold and catalog generator.
- `extension/core/activity.js` selects one reportable track across browser tabs.
- `extension/core/presence.js` converts generic media and display data to a
  transport-neutral presence intent. It owns generic text limits, safe
  external URLs, timers, artwork, and button enforcement; site layout and
  button labels come from the Activity or packaged adapter.
- `extension/background.js` owns browser lifecycle, settings, and orchestration.
  It applies the setting keys carried by a provider report or installed
  Activity preferences before handing the generic intent to the publisher.
  It retires Activity documents when a tab loads or is discarded. URL-only
  updates can come from the History API in the same document, so the Activity
  navigation listener handles those without retiring its registered world.
- `extension/discord/auth.js` owns OAuth PKCE, refresh, revocation, and isolated
  token storage.
- `extension/discord/presence.js` owns Headless Sessions, renewal, clearing, and
  transport status.
- `extension/discord/activity-builder.js` converts the transport-neutral intent
  to Discord's headless activity payload.
- `extension/platform/presence-publisher.js` remains the delivery boundary. A
  future supported connector can replace this layer without changing adapters.
- `extension/popup.*` renders detected activity, publisher status, and the
  in-panel settings experience. `core/settings.js` owns shared defaults,
  legacy preference migration, and generic setting-key access. The fixed
  Discord application identity and OAuth redirect URI live in `config.js`.

Provider tracks may contain `source`, `kind`, `title`, `artist`, `album`,
`artwork`, `url`, `channelUrl`, `playing`, `idle`, `ad`, `live`, `position`, and
`duration`. Consumers tolerate missing optional fields.

Installed Activities send reports using a supported Activity API version over
Firefox's dedicated user-script messaging event. The core assigns the Activity ID
from its isolated world registration; a message cannot claim another Activity's
identity. Activities never run in the extension background or receive Discord
credentials. One-shot requests use `runtime.sendMessage` and the extension's
`runtime.onUserScriptMessage` handler. Settings changes, upgrade notices, and
lifecycle shutdown use a per-document `runtime.connect` port accepted by
`runtime.onUserScriptConnect`, so the extension can deliver events to the exact
registered Activity context without targeting it as a content script.

The publisher accepts a presence intent plus the extension's fixed Discord
application ID, or `null` to clear the presence. The OAuth application owns the
single shared Discord login. The publisher returns a delivery status with `id`, `available`,
`state`, and `message` so UI code never has to know which transport is installed.

## Reliability boundary

The extension explicitly clears activity during normal pause, disable, and logout
flows. If a supported tab or window closes, the broker drops that document's
report and selects the next active tab. Firefox does not provide Chrome's
`fetchLater()` or offscreen-document APIs, so Discord session cleanup on normal
shutdown uses a best-effort `fetch(..., { keepalive: true })` request. A browser
crash or forced termination can leave a session until Discord expires it. A
ten-minute extension alarm renews active sessions while Firefox is running.
