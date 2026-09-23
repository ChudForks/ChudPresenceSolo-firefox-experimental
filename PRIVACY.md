# Privacy Policy — ChudPresence Solo for Firefox

Effective date: September 17, 2026

ChudPresence Solo for Firefox shows supported playback activity in a user's
Discord presence. This policy describes the data used for that purpose.

## Data the add-on reads

Packaged providers read playback details on their supported streaming pages.
User-installed Activities can read page content only on the HTTPS sites the user
approves for that Activity. Activity reports are limited to title, creator or
artist, album, artwork and media URLs, playback state, progress, kind, and
optional buttons. It does not read passwords, payment details, private messages,
form entries, browsing history outside approved supported pages, or cookies.

The 67Movies integration uses the movie or TV identifier present in the current
page URL to request matching title, artwork, and runtime metadata from The Movie
Database (TMDB), but only while the user has enabled the 67Movies service.

## Data sent to other services

Nothing is sent to Discord until a user chooses **Connect** and enables sharing.
While sharing is enabled, the add-on sends Discord the information needed to
render the presence: the service name, title, creator or artist, playback state,
optional artwork URL, optional progress timestamps, and optional link buttons.
Discord receives this information to display the user's activity.

For 67Movies, the add-on sends the current movie or TV identifier to TMDB only to
retrieve matching metadata. TMDB's handling of that request is governed by
TMDB's own policies.

The add-on does not sell data, use analytics, inject advertising, or send playback
metadata to the supported streaming services. The Activity Library downloads the
catalog from the public `ChudForks/ChudPresence-Activities` GitHub repository. It downloads
Activity code only when the user installs or updates one, verifies its catalog
hash, and stores the installed source in Firefox extension storage. Community
Activity code runs in a separate Firefox `USER_SCRIPT` world with access only to
its approved site pages and the narrow Activity report messaging API.

## Authentication and local storage

After Discord authorization, the add-on stores Discord OAuth access and refresh
tokens, the active Discord Headless Session token, and user preferences in
Firefox extension storage. This allows the add-on to renew or clear the user's
presence. These credentials are not provided to web pages, packaged site
observers, or Activity scripts.

## User controls and deletion

Users can disable all sharing, disable individual services, disable optional
artwork, timestamps, and links, or use **Disconnect**. Disabling 67Movies also
stops its TMDB metadata lookups. Disconnect clears the
active Discord presence, removes stored tokens, and asks Discord to revoke the
authorization. Before uninstalling the add-on, use **Disconnect** if the user
wants to revoke Discord authorization immediately.

## Changes and contact

Material changes to this policy will be published with an updated add-on version.
For privacy questions, use the support contact listed on the add-on's
addons.mozilla.org page.
