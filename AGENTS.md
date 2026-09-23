# Repository instructions

## Client build contract

- Author client startup in `client/plugin-entry.tsx`. `index.client.tsx` is a
  stable wrapper around `client/generated-entry.js`.
- Never edit or commit `client/generated-entry.js`; it is an ignored minified
  artifact. Run `npm run build:client`, or keep `npm run dev` active while
  changing files under `client/` or `shared/`.
- Use `npm run reload` instead of calling `paseo plugin reload inline-review`
  directly. It regenerates the entry and typechecks before reload.
- Keep the `paseo-plugin.json` build commands and the package `prepare` hook in
  sync. Managed installs must remain shell-independent and reproducible from
  `package-lock.json`.
- Client prebundling may externalize only Paseo's plugin modules, React,
  React Native, and Zod. Node built-ins and server modules must not enter the
  client graph.

## Performance invariants

- `shared/syntax.ts` stores packed word lists. Expand a canonical language on
  first use and cache only its immutable scanner template; per-highlight
  structural state must remain local to that call.
- Wide-frame cleanup is a cross-bundle lease with a 5,000 ms grace period.
  A replacement bundle must cancel an older pending cleanup in either reload
  ordering. An explicit disabled setting must still undo styles immediately.
- Do not move startup work ahead of `registerTimeline`; it is the only
  startup-critical contribution.

## Verification

- Run `npm run typecheck` and `npm test` for every source change.
- For startup or bundle changes, also run `npm run benchmark:startup`,
  `npm run perf`, and `npm run size:client`. After an authorized plugin reload,
  run `npm run size:installed` and inspect desktop and compact/mobile layout.
- Keep regression tests for generated-entry freshness, external import
  boundaries, syntax-cache behavior, lease ordering, immediate disable, and
  complete DOM cleanup.
