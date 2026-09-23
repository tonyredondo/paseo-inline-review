# paseo-inline-review

A [Paseo](https://paseo.sh) plugin for commenting on agent responses inline and sending the comments back as a review.

## What it does

- Replaces each assistant response in the timeline with a paragraph view: tap a paragraph to attach a comment anchored below it. Text uses the plugin's own CommonMark-style parser with GFM tables because Paseo does not expose its native markdown renderer to plugins.
- Adds a "Review (n)" composer pill for every agent that opens the plugin panel.
- Comments persist in the daemon store and carry a status: **pending** comments are included in the next "Send to agent"; **sent** comments stay visible as muted conversation context (and can be re-opened).
- The agent panel offers:
  - **Send to agent**: sends the pending comments (plus an optional note) directly to the agent through the SDK and marks them sent.
  - **Clear**: discards the agent's comments.

## Install

```bash
paseo plugin add tonyredondo/paseo-inline-review
```

Paseo runs the plugin's declared build steps during managed installs and
updates. They install the pinned npm dependencies and generate the minified
client entry automatically; a failed build leaves the previous installed
version active.

or from a local checkout:

```bash
npm install
paseo plugin install /path/to/paseo-inline-review
```

`npm install` also generates the client entry through the package `prepare`
hook. This keeps local installation compatible with Paseo versions that
predate managed plugin builds.

## Development

```bash
npm install
npm run dev                 # watch client/ and shared/ and rebuild on changes
npm run typecheck
npm test
npm run reload              # build, typecheck, then reload the plugin
paseo plugin logs inline-review
```

The authored client entry is `client/plugin-entry.tsx`.
`client/generated-entry.js` is an ignored, minified build artifact consumed by
the stable `index.client.tsx` entry; do not edit it. `npm run build:client`
updates it once, while `npm run dev` keeps it current during editing. The
typecheck, test, performance, and reload commands rebuild it automatically.

Performance checks:

```bash
npm run benchmark:startup   # direct bundle versus the two-pass minified entry
npm run perf                # rendering, stores, scanner cache, and transfer models
npm run size:client         # minified transfer proxy and client import boundary
npm run size:installed      # authoritative bundle served by the running daemon
```

The syntax highlighter keeps language data packed until first use and caches
one immutable scanner template per canonical language. Wide-frame DOM styles
use a five-second cross-bundle lease: a healthy reload takes ownership without
showing Paseo's default frame, while a plugin that does not return still has
its old styles removed after the grace period. Turning the feature off in
settings remains immediate.

Requires Paseo >= 0.8.0 with plugins enabled on the daemon (`Settings → Plugins → Enable plugins`, or `pluginsEnabled: true` in the daemon config).
