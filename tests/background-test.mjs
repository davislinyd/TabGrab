import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(projectDir, "background.js"), "utf8");
const installedListeners = [];
const clickedListeners = [];
const createdMenus = [];
const consoleErrors = [];
let queriedTabs = [];
let lastQuery = null;
let sentMessage = null;
let offscreenContexts = [];
let offscreenCreateCount = 0;

const context = vm.createContext({
  console: {
    error: (...args) => consoleErrors.push(args.map(String).join(" "))
  },
  chrome: {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      onInstalled: { addListener: (listener) => installedListeners.push(listener) },
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      getContexts: async () => offscreenContexts,
      sendMessage: async (message) => {
        sentMessage = message;
        return { ok: true };
      }
    },
    contextMenus: {
      onClicked: { addListener: (listener) => clickedListeners.push(listener) },
      removeAll: (callback) => callback(),
      create: (properties, callback) => {
        createdMenus.push(properties);
        callback();
      }
    },
    tabs: {
      query: async (query) => {
        lastQuery = query;
        return queriedTabs;
      }
    },
    offscreen: {
      createDocument: async () => {
        offscreenCreateCount += 1;
      }
    }
  }
});

vm.runInContext(`${source}\n;globalThis.__tabgrabTest = {
  MENU_IDS,
  createContextMenus,
  getSelectedTabs,
  formatTabs,
  escapeMarkdownTitle,
  escapeMarkdownUrl,
  handleContextMenuClick,
  ensureOffscreenDocument
};`, context);

const api = context.__tabgrabTest;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.equal(installedListeners.length, 1);
assert.equal(clickedListeners.length, 1);

await api.createContextMenus();
assert.deepEqual(
  plain(createdMenus.map((menu) => ({ id: menu.id, parentId: menu.parentId, contexts: menu.contexts }))),
  [
    { id: "tabgrab-root", contexts: ["tab"] },
    { id: "tabgrab-copy-url", parentId: "tabgrab-root", contexts: ["tab"] },
    { id: "tabgrab-copy-title-url", parentId: "tabgrab-root", contexts: ["tab"] },
    { id: "tabgrab-copy-markdown", parentId: "tabgrab-root", contexts: ["tab"] }
  ]
);
createdMenus.length = 0;
await Promise.all([api.createContextMenus(), api.createContextMenus()]);
assert.equal(createdMenus.length, 4);

queriedTabs = [
  { index: 5, title: "Five", url: "https://five.example/" },
  { index: 1, title: "One", url: "https://one.example/" },
  { index: 3, title: "Missing" },
  { index: 2, title: "Two", url: "https://two.example/" }
];
const selected = await api.getSelectedTabs(42);
assert.deepEqual(plain(lastQuery), { windowId: 42, highlighted: true });
assert.deepEqual(Array.from(selected, (tab) => tab.index), [1, 2, 5]);

await api.getSelectedTabs(undefined);
assert.deepEqual(plain(lastQuery), { currentWindow: true, highlighted: true });

const formatTabs = [
  { title: "Example", url: "https://example.com/" },
  { title: "", url: "https://github.com/" },
  { title: "Ignored" }
];
assert.equal(api.formatTabs(formatTabs, "url"), "https://example.com/\nhttps://github.com/");
assert.equal(
  api.formatTabs(formatTabs, "title-url"),
  "Example\nhttps://example.com/\n\nhttps://github.com/"
);
assert.equal(
  api.formatTabs(formatTabs, "markdown"),
  "[Example](https://example.com/)\n[https://github.com/](https://github.com/)"
);
assert.equal(api.escapeMarkdownTitle("Test [Page] \\ Example"), "Test \\[Page\\] \\\\ Example");
assert.equal(
  api.escapeMarkdownUrl("https://example.com/a (b)\\c"),
  "https://example.com/a%20%28b%29%5Cc"
);
assert.throws(() => api.formatTabs([], "unknown"), /Unknown format/);

queriedTabs = [{ index: 0, title: "Example", url: "https://example.com/" }];
offscreenContexts = [{ contextType: "OFFSCREEN_DOCUMENT" }];
sentMessage = null;
assert.equal(await api.handleContextMenuClick({ menuItemId: api.MENU_IDS.URL }, { windowId: 7 }), true);
assert.deepEqual(plain(sentMessage), { type: "tabgrab-copy", text: "https://example.com/" });

queriedTabs = [{ index: 0, title: "Missing URL" }];
sentMessage = null;
assert.equal(await api.handleContextMenuClick({ menuItemId: api.MENU_IDS.URL }, { windowId: 7 }), false);
assert.equal(sentMessage, null);
assert.match(consoleErrors.at(-1), /No valid URLs found/);

offscreenContexts = [];
offscreenCreateCount = 0;
await Promise.all([api.ensureOffscreenDocument(), api.ensureOffscreenDocument()]);
assert.equal(offscreenCreateCount, 1);

console.log("PASS Context menus, selection, formatting, errors, and offscreen locking");
