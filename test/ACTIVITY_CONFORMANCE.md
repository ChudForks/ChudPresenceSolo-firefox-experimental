# Activity API V1 conformance coverage

`activity-conformance.test.js` is the synthetic Activity runtime suite. It runs
the registered user-script wrapper in a VM with a synthetic page and browser
API, then drives the same operations an installed Activity uses.

| Capability | Conformance coverage |
| --- | --- |
| DOM helpers | `provides a frozen ChudPresence runtime with report, page, and network helpers` |
| SPA navigation | Same integration case; `navigation.onChange()` observes synthetic History API updates. |
| Media detection | Same integration case; media selection, snapshots, and events use synthetic audio/video nodes. |
| MAIN-world execution | `executes page functions in the requesting Activity document and serializes results` |
| Iframe reports | `supports top and embedded player frames and rejects reports from replaced child documents` |
| Same-document queue navigation | `a queue-style URL update keeps the same document eligible to report`; the YouTube Music package test changes its track and watch URL. |
| External networking | `brokers allowlisted cross-origin requests without credentials and records Activity identity` |
| Activity storage | `isolates Activity storage and preserves it across updates while removing it on uninstall` |
| Settings | `persists declarative Activity settings, rejects invalid values, and defaults values invalid under a new schema` |
| Lifecycle cancellation | Runtime integration case; teardown aborts the signal, timers, and cleanup callbacks. |
| Logging | `records report lifecycle diagnostics and bounds Activity logs` |
| Presence report and clear | Runtime integration case and `accepts reports only from the installed Activity world and declared site`. |
| Updates and migration | `keeps the previous Activity operational when an update fails before commit` and `runs one persisted upgrade transition after a version change and records migration failures`. |

Run the suite with `npm test`. The cases use synthetic pages and fake browser
APIs, so they do not depend on a logged-in streaming account or Discord session.
The separate Activities repository runs synthetic page tests for the
Crunchyroll and YouTube Music packages, including settings changes and prompt
clears after a navigation or advertisement. Mozilla `web-ext lint` and a
temporary headless Firefox install check the extension package layout. A real
Firefox session with user permission prompts and logged-in playback is still
needed to verify end-to-end installation, discovery, reporting, and Discord
presence.
