# Manual native Edge verification

Use a disposable Edge profile. Do not run these checks in a daily browser profile.

Record every result as `PASS`, `FAIL`, `SKIPPED`, or `MANUAL VERIFICATION REQUIRED`. An unexecuted check is never `PASS`.

## Setup

1. Load this repository with **Load unpacked** at `edge://extensions`.
2. Open five ordinary HTTPS tabs and one `edge://version/` tab.
3. Keep a text editor available for pasting clipboard results.

## A — Cmd/Ctrl multi-selection

1. Select tabs 1, 3, and 5 with Cmd + Click on macOS or Ctrl + Click on Windows.
2. Right-click selected tab 3.
3. Confirm the menu contains **TabGrab → Copy URLs**, **Copy Title + URLs**, and **Copy as Markdown**.
4. Choose **Copy URLs** and paste.
5. Confirm the output contains URLs 1, 3, and 5 in tab-strip order.

## B — Shift range

1. Click tab 1, then Shift + Click tab 4.
2. Confirm tabs 1–4 are highlighted.
3. Run **TabGrab → Copy URLs** and confirm four URLs are copied in order.

## C — Title + URL

Select two tabs and confirm the output is:

```text
Title
URL

Title
URL
```

## D — Markdown

Select two tabs and confirm each output line is `[Title](URL)`. Include a page whose title contains `[`, `]`, or `\` when available.

## E — Selection order

Select tabs in the order 5, 1, 3. Confirm copied output remains ordered 1, 3, 5.

## F — Right-click an unselected tab

1. Select tabs 1 and 3.
2. Right-click unselected tab 4.
3. Record Edge's resulting highlighted set before choosing a command.
4. Confirm TabGrab copies exactly that resulting set; do not expect TabGrab to preserve its own selection state.

## G — Special URL

Select `edge://version/` with an HTTPS tab and run all three formats. Confirm no command crashes and every URL exposed by the Tabs API is copied.

## H — Toolbar panel

1. Click the TabGrab toolbar icon.
2. Confirm highlighted tabs are selected initially.
3. Search for a tab, adjust the selection, choose each copy format, and paste the result.
4. Reopen the panel and confirm the most recently selected format is retained.
