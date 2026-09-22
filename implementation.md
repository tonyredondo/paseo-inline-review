# Performance hardening implementation plan

Status: implemented locally; automated and Paseo Desktop verification complete; physical iPhone verification pending
Baseline revision: `f09ebdb5cb62c2960edff345d1f21284d090c991` (`main`)
Scope: changes owned by `paseo-inline-review`; no Paseo host changes
Primary clients: Paseo Desktop/Web and compact native clients, especially iPhone

## Implementation result (2026-09-22)

The initial performance work was published in `92c74ce`. The code preserves host-owned attachment rows and does not attempt to hide the native pre-plugin paint, which remains a Paseo lifecycle boundary.

| Phase | Implemented result |
| --- | --- |
| 0 | Added deterministic `npm run perf`, source and installed-bundle size reports, injectable schedulers, operation/byte/cache counters, and characterization coverage. Structural output was identical across three consecutive runs after removing elapsed-time fields. |
| 1 | Replaced per-agent five-second loads with one revision/epoch batch synchronization controller. It singleflights overlapping work, protects dirty agents, pauses in background, refreshes on resume/save recovery, and backs unchanged foreground polling from 15 to 30 to 60 seconds. |
| 2 | Turn-final indexes fetch one 300-entry tail initially and older 400-entry pages only when a mounted row needs them. Page walks and indexes are shared, retained for 120 seconds, invalidated by epoch, and explicitly disposed on plugin cleanup. |
| 3 | Added a bounded thumbnail RPC and client/server stores with mount delay, singleflight, concurrency 2, stale-result rejection, byte-bounded LRU caches, file-identity verification, retry, and a 100 KiB output cap. Compact remote images and every full-resolution local image require interaction. |
| 4 | Comment and file I/O now use asynchronous handles. Comment mutations use delta saves while the full RPC remains for compatibility. Downloads use 768 KiB compact and 2 MiB desktop chunks, sequential progressive writes, source-version validation, and destination abort on failure. |
| 5 | Added compiled Markdown and inline-token caches bounded by 2,000,000 source characters, completed-message reuse, 50 ms streaming coalescing with immediate final publication, prefix-only collapsed highlighting, large-block virtualization, agent/message comment indexes, and stable re-anchor tracking. |
| 6 | Timeline registration is the first contribution, renderers are registered before transformers can replace native rows, every contribution is cleaned up, and the client import audit excludes server/Node/image-processor code. Added an authoritative installed-catalog size check. |
| 7 | Desktop observes the smallest common timeline ancestor, classifies only relevant mutation scopes, repairs style-only rewrites without a document scan, and replaces the fixed sweep with a 2.5-to-60-second adaptive fallback. Controller election and styling happen before paint; workspace re-entry immediately rebinds and rescans instead of waiting for the fallback. Cleanup restores every owned style, marker, listener, observer, timer, and frame. |
| 8 | The complete automated matrix, 25 repeated lifecycle/concurrency iterations, exact plugin reload, log inspection, and a final Desktop visual check passed. The physical iPhone matrix is still a manual release gate because no iPhone surface is available in this environment. |

### Final measured evidence

- `npm test`: 214 tests passed, including all pre-existing parser/render/persistence contracts and the new synchronization, lazy history, thumbnail, progressive download, streaming, startup-order, pre-paint, and fake-DOM regressions.
- `npm run typecheck` and `git diff --check`: passed.
- Stress: 25 consecutive iterations passed for comment synchronization, thumbnail client/server singleflight and eviction, progressive download abort/order, adaptive sweeps, mutation routing, and turn-index lifecycle.
- Comment synchronization: 1, 9, and 100 agents each produce one RPC per tick; unchanged foreground state backs off to one request per minute and background state produces none.
- Initial turn history: one 300-entry tail request and zero historical requests. Older history remains demand-driven with a twelve-page safety cap.
- Images: zero automatic full-resolution RPCs. Thumbnail work and client fetches are each capped at two concurrent operations; remounts hit bounded memory caches.
- Markdown: a 500 KiB completed fixture reuses its compiled document on remount; the collapsed 500-line fixture highlights only 40 lines.
- Downloads: a 5 MiB compact transfer uses seven bounded chunks; desktop uses three. Tests prove ordered writes and abort-on-error behavior.
- Plugin: reloaded from this checkout, reported `running`, and logged `Plugin ready` at `2026-09-22T20:04:04.067Z` without a new processor error.
- Desktop: the post-reload timeline rendered at the widened stable width with plugin messages visible and no blank-row regression.

### Re-entry paint follow-up

A real re-entry still exposed three visible phases: native rows, partial plugin styling, and cards. Three red-capable regressions isolated the plugin-controlled causes:

- The elected wide-frame owner used a passive effect, so the controller did not mount until after the first browser paint. Ownership and DOM styling now both use layout effects.
- An already installed wide-frame controller returned without scanning or rebinding when Paseo replaced the workspace DOM. Re-entry now reinstalls synchronously against the current subtree instead of waiting up to the adaptive fallback interval.
- Transformers were installed before their renderers. Renderers now exist first, so a host that publishes registrations incrementally never sees a plugin timeline item without its component.

The installed bundle is 246,418 raw bytes and 52,084 gzip bytes. Twenty local catalog samples measured 1.04 ms median / 2.01 ms p95; twenty parse/compile samples measured 1.90 ms median / 2.19 ms p95. Those values rule out plugin catalog lookup or JavaScript compilation as the source of a large local delay. A cold native frame painted before Paseo loads the client bundle remains host-owned; plugin-local persistence cannot execute early enough to remove it, and caching settings independently would risk painting the wrong saved state.

### Bundle warning analysis

The installed client bundle changed from 216,783 to 246,418 raw bytes and from 45,806 to 52,084 gzip bytes: +13.67% raw and +13.71% gzip. This deliberately trips the 10% warning and adds 6,278 gzip bytes once per plugin load. The catalog audit proves the client artifact does not contain `sips`, server image-processing code, or Node imports. The growth is the bounded client synchronization, lazy-history, thumbnail, cache, coalescing, and lifecycle logic; it removes repeated traffic that previously reached about 629 KiB per minute for nine comment buckets and prevents an automatic 5 MiB image from becoming about 6.67 MiB of base64. Given that recurring reduction and the absence of a supported client chunking contract, the warning is accepted rather than weakening the runtime controls.

### Decision gates resolved

- `sharp` was rejected after the clean installed plugin failed to load its Darwin arm64 runtime twice. It was removed from the manifest and lockfile. The production processor is an isolated macOS `sips` adapter; other daemon platforms return an explicit thumbnail-unavailable error while preserving the full-image action. Animated inputs deliberately use a static first-frame preview.
- A disk thumbnail cache was not added: the measured bounded memory caches remove remount work, while a cold restart costs one bounded platform process per cache miss. There was no evidence that justified persistent data and cleanup complexity.
- Generic text compression was rejected after a measured round trip. Revision metadata, delta saves, thumbnails, and smaller chunks remove the large payloads without adding a client decompressor or double-compressing images.
- Two-chunk download prefetch was not added because ordered sequential writes already bound frames and no high-latency measurement justified parallel reads over the shared WebSocket.
- The native-to-plugin flash cannot be fully removed from this repository. Registering the timeline first, making renderers available before transformers, and applying web styling in the pre-paint layout phase remove the plugin-controlled intermediate states; caching or preloading the bundle before the first native timeline paint requires a Paseo host hook.

### Remaining release proof

Run the Phase 8 physical-iPhone matrix before release: cold/warm open, fast history scrolling, zero/one/three-image messages, thumbnail/full viewer, background/resume, reconnect, and cross-device comment edit/delete. Native contracts are covered by regression tests, but a real-device pass has not been observed here and is not represented as complete.

## Goal

Reduce the plugin-controlled portion of chat startup time, scrolling work, network traffic, daemon blocking, and memory use without changing the current review workflow or timeline semantics.

The host paints its native timeline before it installs plugin transformers. The plugin cannot remove that initial host-owned paint. This plan therefore targets the work that begins once the client contribution is evaluated: background synchronization, timeline history indexing, image transfer and decoding, Markdown rendering, file I/O, and desktop DOM maintenance.

## Baseline evidence

Record these measurements again immediately before implementation so the comparison uses the same device, chat, daemon, and revision:

- The current client bundle is approximately 216,783 bytes uncompressed and 45,806 bytes with gzip in the local measurement. Bundle transport compression is owned by Paseo and must not be assumed.
- With nine agents, `client/pills.tsx` can issue 54 plugin RPCs every 30 seconds: one load per agent every five seconds. The current persisted data contains 57 comments and 12 tombstones across nine response buckets; one compact polling round is approximately 52,394 bytes, or approximately 629 KB/minute per active client before protocol framing.
- One turn-final index requests a 300-entry tail and can eagerly request twelve 400-entry historical pages: up to 5,100 entries per index creation.
- Local inline Markdown images are read in full, base64-encoded, and transferred as soon as their component mounts. Base64 adds approximately 33.3% to the byte count before JSON and client-side copies. A 5 MiB image becomes approximately 6.67 MiB of base64 text.
- Three representative screenshots resized to a 640 px JPEG thumbnail were reduced by 85.3%, 89.8%, and 29.8%. The last source was already only 592 px wide.
- On the current Mac, representative 500 KB inputs took approximately 19.8 ms for inline Markdown parsing and 24.7 ms for syntax highlighting. These are comparison baselines, not iPhone performance claims.
- Current daemon metrics show about 73,000 timeline items in total and more than 30,000 for the largest agent. This makes repeated eager history work material.

Add `scripts/perf-baseline.ts` and an `npm run perf` command in Phase 0. The script must report operation counts, input/output bytes, cache hit rates, and elapsed time, but normal correctness tests must not fail on wall-clock thresholds.

## Contracts that must not regress

Every phase must preserve these behaviors unless this plan explicitly changes the image loading policy:

- Assistant messages continue to render their complete text while streaming and after completion.
- Only the last assistant message after the last tool call of a completed turn receives the final card; earlier assistant/tool fragments remain in order.
- Live fragments that consolidate into one historical assistant message still form one visual card without blank rows or duplicate cards.
- Plain user messages retain their current desktop and native cards. Rows with host-owned attachments stay with the native Paseo renderer; the plugin must not discard attachments it cannot read.
- Review comments retain ordering, pending/sent state, revisions, list-item anchors, cross-device merge behavior, and tombstone protection against resurrection.
- A successful send is never reported as unsent merely because persistence is delayed; a persistence failure remains visible to the caller.
- Plugin cleanup flushes pending writes and removes timers, subscriptions, queues, observers, and cache-owned resources.
- Local text previews, image previews, external links, progressive downloads, file-version checks, and the native/desktop viewer continue to work.
- Desktop wide-frame behavior and user-message layout remain stable across React remounts. Compact native clients must not execute DOM code.
- Themes, accessibility labels/roles, keyboard behavior, selection, hover controls, compact spacing, and error/loading states remain intact.
- Plugin runtime boundaries remain valid: client code cannot import server or Node modules, server code cannot import client modules, and shared contracts remain JSON/Zod compatible.

## Verification discipline

For each phase:

1. Add a characterization test for any current behavior being refactored.
2. Add a focused regression or operation-count test that is red-capable for the inefficiency being addressed. Run it and record the expected failure before changing production behavior.
3. Make the smallest implementation change that turns it green.
4. Run the focused test, every test for the touched subsystem, then the complete suite and TypeScript.
5. Inspect the diff and compare the relevant `npm run perf` scenario against the recorded baseline.
6. Reload the exact local plugin installation, require `running`, inspect plugin logs, and test the real UI on desktop and iPhone when the phase affects rendering or networking.
7. Stop and investigate if behavior changes outside the phase, if the performance metric does not improve materially, or if a third correction for the same failure would be required.

Keep phases in separate commits during implementation so each optimization can be reverted independently. Committing or publishing those future changes still requires the authorization in effect when implementation starts.

## Phase 0: deterministic performance harness and characterization

### Purpose

Create repeatable signals before changing architecture. Prefer counts and payload sizes over timing assertions in CI.

### Changes

- Add `scripts/perf-baseline.ts` with fixed synthetic fixtures for:
  - comment synchronization across 1, 9, and 100 agents;
  - turn histories with recent and deeply historical final messages;
  - Markdown with 10 KB, 100 KB, and 500 KB bodies;
  - collapsed and expanded code blocks;
  - local images of 100 KiB, 1 MiB, and 5 MiB;
  - file downloads with deterministic chunk sizes.
- Report RPC count, timeline pages/entries requested, bytes transferred, parse/highlight invocations and input lengths, cache hit/miss counts, maximum concurrent work, and cleanup state.
- Add test-only injectable clocks/schedulers and counters at the ownership boundaries. Do not leave production debug logging or message/path contents in logs.
- Add or strengthen characterization coverage in:
  - `test/review-store.test.ts`
  - `test/server-review.test.ts`
  - `test/turn-final-store.test.ts`
  - `test/markdown.test.ts`
  - `test/render-contract.test.ts`
  - `test/wide-frame.test.ts`

### Red-capable regression signals

The baseline harness records the current counts without making the normal suite permanently red. At the start of each implementation phase, promote the relevant target below into a normal regression test, run it once to observe the expected failure, and then implement the fix in the same phase.

- Nine agents require no more than one comment-sync RPC per synchronization tick. This must fail against the current per-agent poller.
- Initial turn-index startup performs one tail request and no historical request until a mounted message needs older data. This must fail against the current eager backfill.
- A compact local-image row performs no full-image RPC before explicit full-view interaction. This must fail against the current `LocalMarkdownImage` effect.
- A collapsed 500-line code block sends no more than the visible prefix to the syntax highlighter. This must fail against the current full-block highlighting.

### Exit criteria

- `npm run perf` produces stable structured output across three consecutive runs.
- The harness can demonstrate the four current violations; each target becomes a failing normal test immediately before its corresponding fix.
- Existing tests remain green after test seams are introduced.

## Phase 1: replace per-agent polling with revision-based batch synchronization

### Design

- Add a `review.sync-comments` RPC in `shared/review.ts` that accepts all known agent revisions in one request and returns only changed agent buckets.
- Give the server an opaque process epoch plus a monotonically increasing revision per agent. Persisted comments remain backward compatible; a daemon restart changes the epoch and forces one full refresh instead of requiring a risky store migration.
- Increment an agent revision only when the merged comments or tombstones actually change.
- Add a `client/comment-sync.ts` controller that owns:
  - one in-flight synchronization promise;
  - coalescing of overlapping ticks into one trailing synchronization;
  - a foreground interval and a slower unchanged-data backoff;
  - jitter so multiple devices do not synchronize on the same boundary;
  - pause/resume through React Native `AppState`, after verifying that the installed client runtime exposes it;
  - immediate synchronization after reconnect/resume and after a failed save recovers;
  - cleanup of timers and listeners.
- Keep local optimistic mutations and current save ordering. Do not allow a poll response to overwrite a dirty local agent.
- Register pills for all existing agents as today, but make label hydration consume the one shared synchronization result.

### Regression tests

Add `test/comment-sync.test.ts` covering:

- 1, 9, and 100 agents produce one RPC per tick.
- An unchanged revision returns no comments and does not notify subscribers.
- A change to one agent returns and hydrates only that agent.
- Two concurrent ticks share one request and retain one trailing refresh.
- Background state cancels the timer; resume performs exactly one immediate sync.
- Errors back off without discarding local state; success resets the backoff.
- Cleanup prevents any later request.
- A pending local save prevents stale remote hydration and is refreshed after the save completes.
- A daemon epoch change forces one complete refresh.

Extend `test/server-review.test.ts` and `test/review-store.test.ts` for revision increments, no-op saves, tombstones, stale edits, and restart epochs. Keep every existing persistence/concurrency test.

### Acceptance criteria

- Nine agents produce one RPC per tick, not nine.
- An idle foreground client produces at most four comment-sync RPCs per minute; a background client produces none.
- Unchanged polling responses carry revision metadata only.
- Cross-device edits, deletions, and sent-status changes become visible within the documented foreground interval.

### Rollback boundary

The old `loadCommentsRpc` may remain temporarily as a compatibility fallback during this phase, but the client must use only one strategy at a time. Remove the fallback after real desktop/iPhone verification.

## Phase 2: make turn-final history demand-driven and retain indexes safely

### Design

- Replace eager `backfillOlder()` with `ensureKnown(messageId, text)` requests triggered by mounted final-fragment candidates.
- Fetch the 300-entry tail once. Fetch older pages only until the requested mounted message is found, history ends, or the existing safety cap is reached.
- Deduplicate simultaneous lookups for the same agent and share fetched pages across all mounted rows.
- Cache page identities and final classifications by agent/epoch/message identity. Invalidate them on timeline epoch replacement rather than every row remount.
- When the last row releases an index, keep it alive for a short grace period (initial target: 120 seconds). A remount inside the grace period reuses it and cancels disposal.
- Add an explicit plugin-level `disposeTurnIndexes()` and call it from `index.client.tsx` cleanup so plugin reload never leaves timers/subscriptions alive.
- Preserve the current 400 ms coalescing of live updates and serialized refresh behavior.
- Never guess finality while an older lookup is incomplete. The temporary state remains an ordinary message, then upgrades to the card when proven.

### Regression tests

Extend `test/turn-final-store.test.ts` with an injected clock and fixtures for:

- Initial startup performs one tail request and zero `before` requests.
- A recent final message is classified from the tail without backfill.
- A mounted old message fetches only the pages necessary to reach it.
- Two mounted old messages share one page walk.
- Releasing and remounting within 120 seconds reuses the subscription and cache.
- Expiry or plugin cleanup releases subscriptions, timeouts, and cached fragments exactly once.
- Timeline epoch replacement invalidates stale final classifications.
- An old lookup finishing after disposal cannot publish state.
- Failures remain retryable and do not create concurrent refetches.
- Existing reused-ID, tool-tail, merged-history, live-fragment, idle/running, and streaming cases remain green.

### Acceptance criteria

- Opening a current conversation requests only the tail.
- Scrolling recent history does not start a full 5,100-entry backfill.
- Re-entering a conversation within the grace period issues no duplicate bootstrap request.
- Historical cards remain correct when reached.

## Phase 3: two-stage image loading with server thumbnails

### Policy

- Full-resolution images must never be fetched automatically while a compact timeline scrolls.
- Compact local images may automatically request a bounded thumbnail after the row remains mounted briefly; full resolution requires an explicit press into the viewer.
- Compact remote HTTP images show a load affordance and do not assign the remote URL to React Native `Image` until pressed, because the plugin server cannot safely thumbnail arbitrary remote URLs.
- Desktop may automatically load thumbnails, but should also avoid transferring a full local image merely to render a small inline card.
- Host-owned user-message attachments remain with Paseo's native renderer. This phase must not replace or hide them because their bytes and URLs are not exposed reliably to the plugin transformer.

### Server design

- Add a separate `review.local-image-preview` RPC rather than overloading download semantics. Input includes path, maximum pixel edge, quality, and an optional known file version. Output includes original dimensions/size when available, file version, output MIME type, thumbnail base64, and thumbnail byte size.
- Keep `review.open-local-file` full-image behavior for explicit viewer actions and backward compatibility.
- Introduce a server-only image processor interface so tests use a deterministic fake.
- Run a packaging spike before selecting the production processor:
  - Prefer `sharp` only if a clean plugin install, reload, Apple Silicon daemon execution, and repository lockfile remain reliable.
  - Keep it server-only and prove it is absent from the client bundle.
  - If the dependency gate fails, ship on-demand full images first and use a clearly isolated macOS `sips` adapter only if portability requirements are explicitly narrowed. Do not silently invoke unavailable system tools.
- Target a 640 px maximum edge for 160 px compact previews at high-density display scale. Start with a 100 KiB output target and documented quality floor; preserve alpha or choose a compatible fallback format when JPEG would be incorrect.
- Detect images by signature as today. Handle PNG, JPEG, GIF, and WebP deliberately; for animation, either return a documented first-frame thumbnail or a placeholder.
- Use asynchronous file handles and verify device/inode/size/mtime/ctime before and after processing.
- Add singleflight deduplication and a priority queue with maximum processing concurrency 2.
- Add a byte-bounded in-memory LRU cache keyed by file identity plus transform parameters. Initial limit: 32 MiB. Cache failures only briefly, if at all.
- Add a hashed, bounded disk cache only after measuring that warm app restarts still regenerate material work. Initial proposal: 128 MiB under the plugin data directory with atomic writes and LRU cleanup. Disk caching is a separate substep and must not block the first thumbnail release.

### Client design

- Add `client/image-preview-store.ts` as the shared owner of thumbnail state, request deduplication, bounded cache, stale-response rejection, retry, and cleanup.
- Mounting starts only the permitted thumbnail policy; it never starts a full-image RPC.
- Limit client thumbnail fetches to two concurrent requests and prioritize mounted rows. Ignore results for rows no longer interested, even if the RPC cannot be canceled.
- Cache by path plus returned file version, bounded by bytes and entry count. Invalidation must fetch a fresh thumbnail when the file changes.
- Preserve loading, error, accessibility, press, and full-view states. An error offers retry and never falls back to silently downloading the full image.
- File-preview tabs and the compact modal may show a cached thumbnail immediately, then fetch full resolution only after explicit viewer interaction.

### Regression tests

Add `test/image-preview-store.test.ts` and extend server/render tests for:

- Compact mount causes no full-image RPC.
- Desktop and compact policies request only a thumbnail automatically.
- A press requests full resolution once and opens the existing viewer.
- Remote compact images do not load before interaction.
- Two rows for the same file share one thumbnail request.
- Queue concurrency never exceeds two and visible work is not starved by stale queued work.
- Unmount/disposal prevents stale state publication.
- Cache hit, eviction, changed-file invalidation, retry, unsupported format, processor failure, and oversized output.
- The server never returns more thumbnail bytes than its configured cap.
- The server rechecks file identity and rejects a file replaced during processing.
- Existing normal file preview still identifies images rather than generic binary data.
- Existing downloads and explicit full-size viewer behavior remain unchanged.
- Host-owned user attachments still bypass the custom user-message card.

### Visual verification

On desktop and iPhone, inspect messages containing zero, one, and three images; short and multiline text; portrait and landscape images; missing files; slow responses; light and dark themes. Verify spacing, viewer navigation, accessibility labels, and that fast scrolling does not start full-image transfers.

### Acceptance criteria

- Zero automatic full-image bytes during compact scrolling.
- Representative 1–5 MiB screenshots transfer a thumbnail near or below 100 KiB before viewer interaction.
- Returning to a cached image causes no new generation and no new transfer while its cache entry is valid.
- Thumbnail generation never blocks unrelated comment or file RPCs behind synchronous file I/O.

## Phase 4: asynchronous persistence, delta saves, and bounded file transfers

### Design

- Replace `openSync`, `readSync`, `statSync`, and synchronous comment writes with `node:fs/promises` equivalents while preserving file identity checks and atomic rename.
- Keep one serialized persistence chain. Resolve a save only after its atomic replacement has completed; retain current cleanup retries and failure propagation.
- Add a delta save RPC containing comment upserts and tombstone IDs instead of sending the entire agent list after every mutation. Continue comparing comment revisions server-side so stale devices cannot overwrite newer comments.
- Preserve the existing full-snapshot save temporarily for migration/recovery and remove it only after real cross-device verification.
- Keep the 5 MiB server maximum as a compatibility safety rail, but let clients request smaller chunks. Start compact/native downloads at 512 KiB–1 MiB and desktop at 2 MiB, then measure.
- Keep progressive writes ordered and sequential initially. Test a maximum two-chunk prefetch only if high-latency measurements show meaningful improvement; do not add unbounded parallel reads over one WebSocket.
- Do not gzip/JPEG/PNG/WebP payloads. Images are already compressed and resizing dominates generic compression.
- Add a measured experiment for large text payload compression only. It must include decompression cost and client-bundle cost; reject it unless end-to-end bytes and latency improve materially. Avoid adding a client compression library merely to reduce small comment payloads already eliminated by revision sync.

### Regression tests

- Async reads never exceed the requested chunk or preview cap.
- File descriptors close on success, error, timeout, and file replacement.
- Same-size replacement between chunks is still rejected.
- Progressive destination writes remain ordered and abort on any failed chunk.
- Delta saves preserve unsent edits, sent-state transitions, tombstones, list anchors, and deterministic conflict resolution.
- Concurrent saves remain serialized; the newest local revision wins.
- Cleanup performs the final dirty save and retains three-attempt recovery.
- A corrupt or unavailable store still fails closed and is never overwritten as empty.
- Old persisted store files load without migration loss.

### Acceptance criteria

- Large image/file reads no longer block the plugin server event loop synchronously.
- One comment mutation transfers only the changed records/tombstones.
- Mobile file transfers do not create multi-megabyte JSON frames while preserving throughput and integrity.

## Phase 5: compile Markdown once and avoid hidden full-code work

### Design

- Introduce a compiled Markdown document representation containing block structure and inline tokens. Renderers consume it instead of repeatedly calling `parseInline()`.
- Parse a single-image paragraph once; remove the current repeated tokenization used for detection and rendering.
- Cache completed-message documents in a character/byte-bounded LRU keyed by stable message identity plus text hash. Do not cache partial streaming text globally.
- Coalesce streaming parse/render updates to one scheduled update per frame or a measured 50–100 ms interval while always displaying the final complete snapshot immediately.
- For collapsed code blocks, highlight only the visible prefix. Compute the remainder only after expansion.
- Preserve the 20,000-character per-line plain-text fallback. Virtualize expanded large blocks and avoid constructing React elements for off-screen lines.
- Add comment indexes by agent/message/source so each rendered message does not filter the complete global comment array.
- Track completed comment re-anchoring so stable messages do not repeatedly scan and save unchanged anchors.

### Regression tests

- Run the full existing Markdown/parser corpus unchanged.
- Assert that one render parses each paragraph line at most once.
- Assert that a collapsed 500-line block passes only the visible prefix to the highlighter; expansion processes the full block exactly once.
- Assert cache hits for identical completed messages and invalidation for changed text/message identity.
- Assert bounded eviction by total text size, not only entry count.
- Assert streaming updates coalesce but the final complete text is never delayed or omitted.
- Cover nested emphasis, links/images, tables, alerts, quotes, details, footnotes, long lines, unknown languages, and unclosed streaming fences.
- Verify comment indexing and re-anchoring for message IDs, id-less streaming fragments, list items, edits, deletions, and hydration.

### Acceptance criteria

- No full-block highlighting occurs while a large code block is collapsed.
- Completed history remounts reuse compiled Markdown.
- The 100 KB and 500 KB benchmark scenarios show fewer parser/highlighter input bytes and invocations; record timing as supporting evidence, not the sole proof.
- Markdown visual output remains unchanged on representative desktop and iPhone messages.

## Phase 6: client startup and bundle discipline

### Design

- Keep timeline transformer/renderer registration synchronous and move it before nonessential panel setup only if the Phase 0 instrumentation shows a measurable registration delay. Current warm measurements suggest this is a micro-optimization.
- Ensure all image-processing dependencies are reachable only from `index.server.ts`; verify the client bundle does not contain processor code.
- Audit the large client modules for dead exports and duplicated parsing/style data. Remove only code proven unused.
- Do not attempt dynamic client chunks unless the current Paseo plugin contract explicitly adds support; the current contract supplies one client bundle.
- Do not manually compress the client bundle because Paseo expects executable source. Bundle/catalog transport compression is host-owned.
- Add a size report and a warning threshold for unexpected growth. A performance feature may grow the server bundle, but client growth over 10% requires explicit analysis.

### Regression tests

- Import-boundary audit: no client-to-server/Node imports and no native image processor in the client artifact.
- Contribution cleanup remains idempotent and removes every registration/controller.
- Timeline transformers stay synchronous and deterministic.
- TypeScript validates against the documented Paseo `>=0.8.0` contract.

### Acceptance criteria

- The client bundle does not materially grow because of server thumbnails or synchronization logic.
- `contribute()` performs no network/file work synchronously and registers the timeline before starting background synchronization.

## Phase 7: reduce desktop-only DOM maintenance

### Design

- Keep this phase isolated from native changes; `client/wide-frame.ts` remains gated to web.
- Observe the smallest stable timeline root that contains widened rows rather than all of `document.body`, if the real Paseo DOM provides one.
- Restrict mutation scans to added/style-changed relevant ancestors and retain the current marker-based idempotence.
- Replace the unconditional 2.5-second full sweep with an adaptive fallback that backs off after stable passes and resets on relevant host mutations or resize.
- Preserve exact cleanup of every inline style, dataset marker, observer, resize listener, media-query listener, timer, and animation frame.

### Regression tests

Extend `test/wide-frame.test.ts` with a behavioral fake DOM rather than adding more source-pattern assertions:

- Unrelated document mutations perform zero timeline scans.
- A host rewrite of one widened row repairs only the affected scope.
- Repeated application is idempotent and does not accumulate padding/width changes.
- Adaptive sweeps back off and wake on a relevant mutation.
- Cleanup restores all original styles and prevents later callbacks.
- User-message images, hover controls, overflow constraints, tool-call rows, zoom, resize, and remount behavior retain their current contracts.

### Acceptance criteria

- No periodic full-document query occurs every 2.5 seconds during an idle desktop session.
- The flaky width regression remains fixed during streaming, virtualization, zoom, and workspace changes.

## Phase 8: full integration and performance validation

### Automated matrix

Run after every phase and again on the final combined tree:

```bash
npm run typecheck
npm test
npm run perf
git diff --check
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```

Inspect every DOM audit hit; only the guarded web module may contain those APIs.

Add repeated stress runs for concurrency/lifecycle-sensitive tests, for example 25–100 iterations of comment synchronization, index retain/release, thumbnail singleflight, cache eviction, plugin cleanup, and file replacement. A timing test is acceptable only when the injected scheduler makes it deterministic.

### Real Paseo matrix

Before declaring the work complete:

1. Typecheck before every plugin reload.
2. Reload the exact `inline-review` installation without restarting the daemon.
3. Require `Plugin ready`/`running` and inspect plugin logs for initialization, RPC, cleanup, and processor failures.
4. On Desktop/Web, exercise wide and narrow layouts, light and dark themes, hover/focus/keyboard behavior, streaming, a completed turn, historical scrolling, plugin reload, workspace switching, local/remote links, text/image/binary previews, and progressive download.
5. On iPhone, cold-open and warm-open a long chat; scroll rapidly through messages with no images, one image, and three images; open a thumbnail and full viewer; background/resume the app; disconnect/reconnect; send/edit/delete comments across devices; and verify compact spacing and safe areas.
6. Confirm native user messages with host-owned attachments still show every attachment and action.
7. Confirm older final cards remain correct when their history is reached lazily.

### Final measured gates

- Comment synchronization: at most one RPC per tick, at most four idle-foreground ticks per minute, zero background ticks, and changed-agent-only response bodies.
- Initial history: one tail fetch per agent index and no older pages until a mounted row requires them.
- Images: zero automatic full-resolution transfers on compact; bounded thumbnail size/concurrency; cache reuse on remount.
- Rendering: collapsed code highlights only visible lines; completed Markdown uses the compiled cache.
- Lifecycle: no timers, subscriptions, observers, file handles, queued processors, or dirty writes survive plugin cleanup.
- Reliability: the full existing suite plus all new regression tests pass; TypeScript and `git diff --check` pass; the installed plugin is running; both desktop and iPhone checks pass.

## Risks and decision gates

- **Native image dependency:** do not accept `sharp` until cold installation and runtime loading are proven on the supported daemon platforms. Failure falls back to the already useful on-demand policy, not full automatic images.
- **Host attachment ownership:** the plugin cannot optimize bytes for native user-message attachments without a richer Paseo contract. Keep those rows native and report this separately rather than reconstructing incomplete cards.
- **Initial native-to-plugin flash:** the plugin can shorten its own work after installation but cannot eliminate the host's pre-plugin render. Do not claim that these phases remove that host lifecycle gap.
- **Cross-device freshness:** reducing polls must not silently make synchronization unreliable. Revision/epoch tests and real two-device checks are mandatory.
- **Cache correctness:** every cache needs explicit byte bounds, invalidation identity, ownership, and cleanup. No unbounded path/text/data-URI maps.
- **Parallelism:** use bounded concurrency only where work is independent. Prefer batching over parallel RPC bursts and preserve sequential ordering for writes and downloads unless measurement proves a safe gain.
- **Compression:** treat it as a measured experiment. Do not add CPU, dependencies, or base64 layers when deltas, thumbnails, or smaller chunks remove more bytes.

## Expected implementation order

Implement in this dependency order:

1. Phase 0 measurement and red-capable tests.
2. Phase 1 comment synchronization.
3. Phase 2 turn-history indexing.
4. Phase 3 on-demand/thumbnail image pipeline.
5. Phase 4 async I/O, delta persistence, and transfer sizing.
6. Phase 5 Markdown/render work.
7. Phase 6 bundle/startup audit.
8. Phase 7 desktop observer optimization.
9. Phase 8 combined desktop/iPhone validation.

Do not begin a later phase to hide an unresolved regression in an earlier one. Re-baseline only after a phase is verified, and keep both the original baseline and the cumulative result in the performance report.
