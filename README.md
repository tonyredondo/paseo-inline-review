# paseo-inline-review

A [Paseo](https://paseo.sh) plugin for commenting on agent responses inline and sending the comments back as a review.

## What it does

- Replaces each assistant response in the timeline with a paragraph view: tap a paragraph to attach a comment anchored below it. Text renders with [CommonMark + GFM tables](https://github.com/ronradtke/react-native-markdown-display) via a bundled dependency (Paseo does not expose its native markdown renderer to plugins).
- Adds a "Review (n)" composer pill for every agent that opens the plugin panel.
- The panel lists the pending comments (removable), supports an optional general note, and offers:
  - **Copy to composer**: copies the formatted review (quotes + comments) to the clipboard so you can paste it into the message composer.
  - **Send to agent**: sends the review directly to the agent through the SDK.
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
