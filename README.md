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

or from a local checkout:

```bash
paseo plugin install /path/to/paseo-inline-review
```

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin reload inline-review
paseo plugin logs inline-review
```

Requires Paseo >= 0.8.0 with plugins enabled on the daemon (`Settings → Plugins → Enable plugins`, or `pluginsEnabled: true` in the daemon config).
