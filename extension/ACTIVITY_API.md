# ChudPresence Activity API v1

Activities are website observers. They run in an isolated Firefox `USER_SCRIPT`
world, read the approved site's DOM and media state, and report normalized data
to ChudPresence. They cannot access Discord publisher internals or extension
storage. Discord formatting, settings, tab selection, and publishing remain in
the packaged extension.

## Package files

Each Activity is a self-contained directory with `metadata.json` and
`activity.js`. Add an optional `icon.png` and set `"icon": "icon.png"` in the
metadata to show its service logo in the extension. The icon is stored as a
validated PNG when the Activity is installed. The metadata schema lives in
the separate `ChudPresence-Activities` repository scaffold.

```json
{
  "id": "example-watch",
  "name": "Example Watch",
  "description": "Show the current video on Example Watch.",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": { "name": "Your name" },
  "category": "video",
  "matches": ["https://watch.example.com/*"],
  "entry": "activity.js",
  "presence": { "kind": "video" }
}
```

Activity IDs are permanent identifiers matching
`^[a-z0-9][a-z0-9-]{1,63}$`. API v1 accepts HTTPS match patterns and runs only in
the isolated `USER_SCRIPT` world.

The metadata and report JSON Schemas are in the
`ChudPresence-Activities/schemas/` directory.

## Runtime

ChudPresence supplies one global API to the Activity source:

```js
ChudPresence.report({
  title: 'Episode title',
  artist: 'Series name',
  url: location.href,
  playing: true,
  position: 120,
  duration: 1440,
  kind: 'episode',
});
```

Call `ChudPresence.clear()` when the page no longer has a reportable activity.
Reports are validated and size-limited by the extension. Supported report
fields are `title`, `artist`, `album`, `artwork`, `url`, `playing`, `live`,
`position`, `duration`, `kind`, `details`, `state`, and up to two `{ label, url }`
buttons. URLs must use HTTPS. Text fields are limited to 256 characters; buttons
to two, with 32-character labels. Supported kinds are `video`, `movie`,
`episode`, `song`, `stream`, `game`, and `generic`. The `live` boolean is
independent of `kind`; use `kind: "stream"` with `live: true` for a live
broadcast. Kinds map to Discord presence as follows: songs to Listening, videos,
movies, and episodes to Watching, games and generic reports to Playing. Streams
use Discord's Streaming type only for Twitch and YouTube URLs; other URLs map to
Watching because Discord validates Streaming links against those services.
Optional metadata `presence.kind` can override the mapping with `music`, `video`,
`streaming`, or `generic`, subject to the same Streaming URL requirement.

Activity code should report promptly when state changes and periodically while
the page remains active. It should not call Discord, fetch unrelated services,
load remote code, read extension storage, or assume another Activity is
installed. Keep packages under 512 KB.

## Permissions and trust

The Library first asks for Firefox's `userScripts` permission, then asks for
only the HTTPS host patterns in the Activity metadata. The script receives a
dedicated isolated world. Activity identity is assigned by ChudPresence during
registration; a report cannot select another Activity's identity. The runtime
checks the sending world, page URL, report shape, field sizes, and report rate.

An Activity can read and observe the pages on its approved sites. Review its
source before installing it. Repository hash checks detect mismatched or
corrupted downloads; they do not establish that an Activity is trustworthy.
