# TabGrab

TabGrab is a Manifest V3 extension for Chrome, Edge, Brave, and other Chromium-based browsers. It lists the tabs in the current browser window and copies selected URLs without sending browsing data anywhere.

## Features

- Start with every tab highlighted in the Chromium tab strip selected automatically.
- Select individual tabs, a Shift-click range, or all visible search results.
- Search by page title, full URL, or domain without losing existing selections.
- Click a domain to select all matching tabs in the current window.
- Copy as URL only, Title + URL, or Markdown.
- Remember the last copy format with local extension storage.
- Handle Chromium internal pages, `about:`, extension pages, file URLs, malformed URLs, and missing favicons safely.
- Accessible labels and visible keyboard focus states.

## Installation

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `TabGrab` project root folder.

### Microsoft Edge

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `TabGrab` project root folder.

### Brave

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `TabGrab` project root folder.

## Usage

Highlight one or more tabs in the browser tab strip with Cmd/Ctrl/Shift, then open TabGrab to start with those tabs selected. You can adjust the selection with checkboxes. Use the search field to filter by title, URL, or domain. **Select All** selects only visible search results, while **Deselect All** clears every selection. Clicking a domain selects all tabs from that domain. Choose a copy format and click the main Copy button.

## Permissions

- `tabs`: reads tab titles, URLs, favicons, order, and active state for the current window.
- `storage`: saves the selected copy format locally.
- `clipboardWrite`: writes the formatted list when the user clicks Copy.

No host permissions, content scripts, or background service worker are used.

## Development

Edit `popup.html`, `popup.css`, `popup.js`, or `manifest.json`, then click **Reload** on the browser's extensions page. To debug, right-click inside the open popup, choose **Inspect**, and review the DevTools Console.

Static validation requires only Node.js:

```bash
node --check popup.js
node --check tests/edge-cdp-test.mjs
node tests/static-test.mjs
```

## Automated Testing with Microsoft Edge + CDP

The integration script uses only Node.js built-ins. It connects to an already-running Microsoft Edge through Chrome DevTools Protocol; it does not install or launch another Chromium build.

Always use an isolated test profile so regular browsing data is unaffected.

### Start Edge on macOS

From the `TabGrab` project root:

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tabgrab-edge-test \
  --enable-unsafe-extension-debugging \
  --disable-extensions-except="$(pwd)" \
  --load-extension="$(pwd)"
```

Adjust the application path if Edge is installed elsewhere.

### Start Edge on Windows

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\tabgrab-edge-test" `
  --enable-unsafe-extension-debugging `
  --disable-extensions-except="C:\path\to\TabGrab" `
  --load-extension="C:\path\to\TabGrab"
```

Adjust the Edge executable and extension paths for the local machine.

### Verify and run

Verify both endpoints in a browser or with a command-line HTTP client:

- `http://127.0.0.1:9222/json/version`
- `http://127.0.0.1:9222/json`

Then run:

```bash
node tests/edge-cdp-test.mjs
```

The script dynamically loads or discovers the unpacked extension through Edge's CDP Extensions domain, uses the returned extension ID, triggers its toolbar action, creates HTTPS and `edge://version/` test tabs, inspects the popup DOM, exercises selection/search/domain behavior, validates format persistence and exact mocked clipboard input, and fails on unexpected runtime exceptions or console errors. Older Edge versions without the Extensions domain fall back to discovery through `edge://extensions` and direct popup navigation.

Internal pages can be blocked by some managed Edge policies. The test reports the special-URL assertion as `SKIPPED`, rather than `PASS`, when Edge does not expose such a tab.

### Edge CDP limitation

Microsoft Edge 152's CDP `Extensions.triggerAction` currently collapses a native multi-tab highlight to one tab before the popup can read it. TabGrab reads `tab.highlighted` directly; verify this behavior manually by highlighting tabs with Cmd/Ctrl/Shift in the tab strip and opening the toolbar action. The remaining CDP assertions can still run normally.

See [`tests/README.md`](tests/README.md) for test details and troubleshooting.

## Project Structure

```text
TabGrab/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── tests/
│   ├── edge-cdp-test.mjs
│   ├── static-test.mjs
│   └── README.md
└── README.md
```

## Privacy

- The extension never sends URLs or other browsing data to an external server.
- It contains no analytics or tracking.
- All selection, formatting, storage, and clipboard operations happen locally.
