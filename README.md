# TabGrab

Grab URLs from selected browser tabs through the toolbar panel or the native tab context menu.

## Version 1.2.0

TabGrab provides two equivalent entry points: the restored toolbar panel for reviewing and adjusting selection, and the native tab context submenu for immediate copying.

## Features

- Uses native Chromium tab multi-selection.
- Adds a `TabGrab` submenu only to the tab context menu.
- Restores the toolbar panel for searching and adjusting tab selection before copying.
- Copies URL-only, Title + URL, or Markdown output.
- Preserves the left-to-right tab strip order.
- Handles browser-internal and other special URLs without reading page content.
- Processes everything locally without saving browsing history.

## Native tab context menu

Select tabs in the browser tab strip:

- Windows/Linux: Ctrl + Click
- macOS: Cmd + Click
- Contiguous range: Shift + Click

Right-click one of the tabs, open **TabGrab**, then choose:

- **Copy URLs** — one URL per line.
- **Copy Title + URLs** — title and URL on separate lines, with a blank line between tabs.
- **Copy as Markdown** — one Markdown link per line.

A single selected tab works normally. TabGrab always follows the highlighted tabs reported by Chromium at the moment the command runs.

## Toolbar panel

Click the TabGrab toolbar icon to open the panel. Highlighted native tabs are selected initially, then you can:

- Search by title, full URL, or domain.
- Select individual tabs or a Shift-click range.
- Select all visible search results or clear the selection.
- Click a domain to select all matching tabs.
- Choose URL-only, Title + URL, or Markdown output.

The panel remembers the last copy format locally.

## Installation

### Microsoft Edge

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root.

### Google Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root.

## Permissions

- `tabs`: reads highlighted tab titles, URLs, window IDs, and positions.
- `contextMenus`: adds the TabGrab submenu to tab context menus.
- `clipboardWrite`: writes the selected output to the clipboard.
- `offscreen`: provides the hidden document required for reliable clipboard access from a Manifest V3 service worker. It tries the Clipboard API first and falls back to extension-authorized `execCommand("copy")` when Edge rejects writes from an unfocused offscreen document.
- `storage`: remembers the toolbar panel's last selected copy format locally.

TabGrab has no host permissions, content scripts, options page, or page injection.

## Privacy

- No analytics or tracking.
- No external requests or third-party services.
- URLs never leave the browser.
- Copied URLs and browsing history are never stored.

## Development

After editing the extension, click **Reload** on the browser extensions page. Run the local checks with Node.js:

```bash
node --check background.js
node --check offscreen.js
node --check popup.js
node --check tests/background-test.mjs
node --check tests/edge-cdp-test.mjs
node tests/static-test.mjs
node tests/background-test.mjs
```

## Edge + CDP Testing

The integration test uses Microsoft Edge rather than bundled Chromium. Always use an isolated profile.

On macOS, from the repository root:

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9333 \
  --user-data-dir="$(pwd)/.edge-test-profile" \
  --enable-unsafe-extension-debugging \
  --disable-extensions-except="$(pwd)" \
  --load-extension="$(pwd)"
```

On Windows:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port=9333 `
  --user-data-dir="C:\path\to\TabGrab\.edge-test-profile" `
  --enable-unsafe-extension-debugging `
  --disable-extensions-except="C:\path\to\TabGrab" `
  --load-extension="C:\path\to\TabGrab"
```

Confirm `http://127.0.0.1:9333/json/version` responds, then run:

```bash
EDGE_CDP_URL=http://127.0.0.1:9333 node tests/edge-cdp-test.mjs
```

See [`tests/README.md`](tests/README.md) for automated coverage and [`tests/MANUAL-EDGE-TEST.md`](tests/MANUAL-EDGE-TEST.md) for native tab-strip verification.

## Known Limitations

- Browser chrome, including the native tab strip and context menu, is not fully controllable through CDP. Cmd/Ctrl, Shift, and right-click behavior requires native Edge verification.
- Right-clicking an unselected tab may change Chromium's highlighted set. TabGrab intentionally copies the set returned by `chrome.tabs.query()` after that native behavior occurs.
- Tabs without a URL exposed by the Tabs API are skipped. If none remain, TabGrab leaves the clipboard unchanged and logs an error.
