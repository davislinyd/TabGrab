# TabGrab tests

## Local tests

`static-test.mjs` validates the Manifest V3 structure, exact permissions, service worker and toolbar popup declarations, local references, and CSP-sensitive markup.

`background-test.mjs` evaluates the service worker against mocked Chromium APIs and verifies menu structure, highlighted-tab queries, ordering, all formats, missing values, Markdown escaping, clipboard messaging, and concurrent offscreen creation.

## Edge CDP integration

`edge-cdp-test.mjs` connects to Edge through `EDGE_CDP_URL` (default `http://127.0.0.1:9333`). It verifies extension loading, service-worker startup, context-menu initialization, `tabs.highlight()` integration, special URLs, real offscreen clipboard writing, toolbar panel rendering, search and selection, format persistence, panel clipboard output, and unexpected runtime errors.

The script does not use Chrome or Playwright Chromium. Start Microsoft Edge with the isolated-profile command in the main README before running it.

Native Cmd/Ctrl, Shift, and right-click interactions occur in browser chrome and cannot be considered automated CDP passes. Follow [`MANUAL-EDGE-TEST.md`](MANUAL-EDGE-TEST.md) and report unexecuted native checks as `MANUAL VERIFICATION REQUIRED`.
