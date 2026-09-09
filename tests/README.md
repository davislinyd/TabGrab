# Edge CDP integration tests

## Scope

`edge-cdp-test.mjs` connects to Microsoft Edge at `http://127.0.0.1:9222`, lists its targets, loads or discovers the unpacked extension ID without hard-coding it, triggers the extension action, and tests:

1. Extension discovery and popup rendering.
2. All tabs highlighted in the native tab strip selected by default, including a single-tab case.
3. Individual checkbox selection and button/count updates.
4. Search filtering with selection preservation.
5. Select All for visible rows only.
6. Deselect All.
7. Same-domain selection.
8. Format changes and `storage.local` persistence after reopening.
9. Exact clipboard text for all three formats through a page-context clipboard mock.
10. Safe rendering of `edge://version/` when Edge exposes it.
11. Unexpected `Runtime.exceptionThrown`, `Log.entryAdded`, and `console.error` events.

The test creates these targets: `https://example.com/`, `https://www.wikipedia.org/`, `https://github.com/`, `https://github.com/openai/`, and `edge://version/`. Use only an isolated Edge profile.

## Native multi-tab limitation

On Microsoft Edge 152, CDP `Extensions.triggerAction` collapses native multi-tab highlighting to one tab before the popup opens. The script reports that assertion as `SKIPPED` when it detects this behavior; manually validate it by selecting tabs with Cmd/Ctrl/Shift in the browser tab strip and then opening TabGrab.

## Run

Start Edge with the command in the main README, including `--enable-unsafe-extension-debugging`, confirm that `/json/version` and `/json` respond, then run from the `TabGrab` project root:

```bash
node tests/edge-cdp-test.mjs
```

Override the endpoint when needed:

```bash
EDGE_CDP_URL=http://127.0.0.1:9333 node tests/edge-cdp-test.mjs
```

## Result meanings

- `PASS`: the assertion executed successfully.
- `FAIL`: the assertion executed and did not meet its requirement.
- `SKIPPED`: Edge policy or environment prevented the assertion from executing.

If extension loading fails, confirm that Edge was launched with `--enable-unsafe-extension-debugging`. Older Edge versions can load **TabGrab** manually from `edge://extensions`; the script then uses its compatibility fallback.
