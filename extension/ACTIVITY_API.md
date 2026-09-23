# ChudPresence Activity API v1

Activity API V1 is a trusted, first-party runtime for official ChudPresence
Activities. V1 grants broad website-observation capabilities to support rich
service integrations, including DOM access, page-context inspection, and
declared external networking. Install V1 Activities from the official
ChudPresence Activities repository or through Developer mode.

Activities run in an isolated Firefox `USER_SCRIPT` world and use the
restricted `ChudPresence` runtime. The extension owns Discord formatting,
credentials, transport, and publishing. Activities do not receive Discord
OAuth/session credentials, extension storage, or unrestricted `browser.*`
access.

V1 is designed for trusted first-party code. A future public/community API may
use a different trust and permission model; this document does not specify that
model or a V2 contract.

## Package files

Each Activity is a self-contained directory with `metadata.json` and
`activity.js`. Add an optional `icon.png` and set `"icon": "icon.png"` in the
metadata. The icon is stored as a validated PNG when the Activity is installed.
Metadata and report schemas live in `ChudPresence-Activities/schemas/`.

`matches` applies separately to each page frame. Metadata may set
`"frames": "all"` to run the same bundled `activity.js` in every matching
frame; it defaults to `"top"`. Use `ChudPresence.runtime.frame.isTop` and the
current page URL to decide which frame should report. For example, declare both
the service page and embedded player host in `matches` to let a child frame
report playback for the parent service.

Optional discovery metadata includes `category`, searchable `aliases` and
`tags`, `contributors`, `homepage`, `repository`, `serviceUrl`, and
`defaultMediaKind`. `excludeMatches` removes matching URLs from the Activity's
runtime scope even when they also match `matches`. The package contract keeps a
single bundled `activity.js`; `frames: "all"` applies that entry to matching
frames.

## Runtime and reports

The current V1 runtime exposes `ChudPresence.report()` and
`ChudPresence.clear()`:

```js
ChudPresence.report({
  kind: 'episode',
  media: {
    title: 'Episode title',
    series: 'Series name',
    season: 1,
    episode: 3,
  },
  playback: { state: 'playing', position: 120, duration: 1440 },
  artwork: { large: 'https://cdn.example.com/episode.jpg' },
  buttons: [{ label: 'Watch', url: location.href }],
});
```

Call `ChudPresence.clear()` when the page no longer has a reportable activity.
Reports use the nested `kind`, `media`, `playback`, `display`, `artwork`,
`buttons`, and `visibility` structure in the report schema. `media.title` is
required; other media fields are optional. If `display` is omitted, songs use
title / artist, episodes use series / episode title, movies use title, and
streams use title / creator. Playback defaults to playing at position zero and
rate one. Visibility supports `normal`, `idle`, `private`, and `ad`; only
`normal` reports are published.

`ChudPresence.runtime` provides the registered `activityId`, package
`activityVersion`, `apiVersion`, `extensionVersion`, a frame descriptor, and
`has(feature)`. `lifecycle` provides an abort signal, cleanup callbacks, and
managed timers. `navigation.current` and `navigation.onChange()` observe SPA
URL changes without replacing History API methods. `media.find()`,
`media.findAll()`, `media.snapshot()`, and `media.onChange()` work with ordinary
audio and video elements. Runtime capabilities can be checked with
`runtime.has(feature)`.

`lifecycle.onUpgrade(({ fromVersion, toVersion }) => ...)` runs for a pending
Activity version transition. Use it for migrations in this Activity's isolated
storage. A completed transition is persisted; a migration error remains pending
and appears in Developer diagnostics. A normal browser restart does not create
an upgrade transition.

`page.execute(fn, args = [])` runs a self-contained, synchronous function in
the current document's page `MAIN` world and resolves to its JSON-compatible
return value:

```js
const title = await ChudPresence.page.execute(
  (key) => window[key]?.title ?? null,
  ['playerState'],
);
```

The function cannot use Activity-scope closures. Arguments must be an array;
the function source and serialized arguments are each limited to 16 KB, and a
serialized result is limited to 64 KB. Results cross a JSON serialization
boundary, so functions, cyclic values, `undefined`, and other non-JSON results
are rejected. A thrown exception rejects the call with an `Error` carrying its
`name`, `message`, and `code`. The runtime targets the requesting document by
its browser document ID and reports a stale-document error if navigation
replaces it before execution returns.

The page can see and interfere with code and data passed through `page.execute`.
The bridge is unavailable on Discord pages. It runs in Firefox's `MAIN` world,
which has no WebExtension-only APIs, and does not expose ChudPresence's Discord
credentials or extension storage. `runtime.has('pageExecute')` reports whether
this capability is present.

`net.fetch(url, options)` makes a bounded request from the extension context.
Declare allowed HTTPS URL patterns in metadata:

```json
{
  "network": ["https://api.example.com/v1/*"]
}
```

```js
const response = await ChudPresence.net.fetch(
  'https://api.example.com/v1/search',
  { method: 'POST', json: { query: 'episode' }, responseType: 'json' },
);
console.log(response.status, response.data);
```

Only `GET` and `POST` are supported. Use `body` for text or `json` for a JSON
request body; choose `responseType: 'json'` (the default) or `'text'`. The
Library requests the declared network host permissions during installation,
and each request must match a declared pattern. Requests omit cookies and
referrers, reject redirects, and cannot target Discord domains. Activities do
not receive an extension `Response` object, browser APIs, or Discord OAuth
material. Request bodies are limited to 64 KB, response bodies to 1 MB, the
default timeout is 10 seconds (maximum 15 seconds), and concurrency is capped
at two requests per Activity and four for the extension. Failures reject with
an `Error` carrying `name`, `message`, and `code`; HTTP error statuses resolve
normally with `ok: false`. Developer Mode records each request with its
Activity, frame, sanitized URL path, status, size, and timing. Query strings
are omitted from diagnostics. `runtime.has('netFetch')` reports this feature.

`storage` provides per-Activity JSON storage:

```js
const choice = await ChudPresence.storage.get('choice');
await ChudPresence.storage.set('choice', { mode: 'compact' });
const removed = await ChudPresence.storage.remove('choice');
const clearedCount = await ChudPresence.storage.clear();
```

Keys are non-empty strings up to 128 characters. A missing key returns `null`;
`set()` resolves to `true`, `remove()` resolves to whether a value existed, and
`clear()` resolves to the number of removed keys. Values must be JSON-compatible
and each Activity has a 64 KB quota. Storage is isolated by the registered
Activity ID, survives package updates, and is deleted when the Activity is
uninstalled. Failures reject with an `Error` carrying `name`, `message`, and
`code`. `runtime.has('storage')` reports this feature.

Activities can declare up to 32 settings in `metadata.json`. Supported types are
`boolean`, `select`, `string`, `number`, and `range`; numeric settings declare
`min` and `max`, with an optional positive `step`. The Library renders the
matching control and saves values with the Activity. Activity code can read
settings and listen for changes:

```js
const displayMode = await ChudPresence.settings.get('displayMode');
const values = await ChudPresence.settings.getAll();
const unsubscribe = ChudPresence.settings.onChange(({ id, value, settings }) => {
  if (id === 'displayMode') updateDisplay(value, settings);
});
```

Change listeners are removed with the Activity lifecycle. Values persist across
updates when the new setting definition still accepts them; changed or removed
values fall back to their new defaults. Invalid setting IDs or values are
rejected. `runtime.has('settings')` reports this feature.

`dom.waitFor(selector, options)` resolves to the first matching element already
present or added later. It accepts `root`, `timeoutMs` (default 10 seconds,
maximum 5 minutes), and `signal`; timeout and cancellation reject with
`TimeoutError` or `AbortError`. `dom.observe(selector, callback, options)` calls
back with each matching element found immediately or added later. Set
`immediate: false` to skip existing elements, `attributes: true` to observe
selector changes caused by attributes, and pass `root` or `signal` to scope or
cancel it. Both helpers use `MutationObserver` and clean up with the Activity
lifecycle. `runtime.has('dom')` reports this feature.

`log.debug()`, `log.info()`, `log.warn()`, and `log.error()` write structured
diagnostic entries for the current Activity. Pass up to eight JSON-compatible
values per call; a log entry is limited to 4 KB. Entries include the Activity
identity, tab, frame, document, and timestamp. Developer Mode keeps a bounded
recent log list and redacts common credential fields, bearer/JWT tokens, and
URL query strings before display. `runtime.has('log')` reports this feature.

URLs must use HTTPS. Text fields are limited to 256 characters, playback values
are bounded, serialized reports are limited to 16 KB, and reports can contain
at most two buttons with 32-character labels. Supported kinds are `video`,
`movie`, `episode`, `song`, `stream`, `game`, and `generic`. The extension
derives presence presentation from these generic semantics; it does not format
an Activity report by Activity ID.

Activity identity comes from the registered user-script world, not from report
data. Runtime calls use structured request/response messages internally; the
extension checks the sending world, page URL, report shape, field sizes, and
request rate. Each report remains tied to its tab, frame, document, and sender
URL. The runtime ignores reports and clears from a document after it has
observed a replacement document in that frame. Replacing the top document also
retires reports from its child frames. A same-document History API URL change
keeps that document eligible to report, including queued playback transitions.
Developer Mode shows active frame IDs,
URLs, and document IDs. Activities do not receive direct `browser.*` or
`chrome.*` API references. Keep packages under 512 KB.

## Permissions and trust

The Library first asks for Firefox's `userScripts` permission, then asks on a
second click for the HTTPS host patterns in the validated catalog entry or
local metadata. It downloads and verifies a repository package after the host
permission prompt, while the click can still activate Firefox's prompt. An
Activity can read and observe pages on its approved sites. Review its source
before installing it.
Repository hash checks detect mismatched or corrupted downloads; they do not
establish that an Activity is trustworthy.

Catalog format support is independent from runtime support. Activities requiring
an unsupported `apiVersion`, or declaring a newer `minExtensionVersion`, stay
visible in Discover with a compatibility message while compatible packages in
the same catalog remain available. Repository installs pin the catalog and
package files to one immutable Git revision. Installed repository records keep
that revision and their metadata, script, and icon hashes. Updates preserve
settings and per-Activity storage; a failed pre-commit update restores the old
package and its live documents. Repository package-file changes require a
strictly higher semantic version in CI.
