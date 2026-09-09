"use strict";

const MENU_IDS = Object.freeze({
  ROOT: "tabgrab-root",
  URL: "tabgrab-copy-url",
  TITLE_URL: "tabgrab-copy-title-url",
  MARKDOWN: "tabgrab-copy-markdown"
});

const FORMATS_BY_MENU_ID = new Map([
  [MENU_IDS.URL, "url"],
  [MENU_IDS.TITLE_URL, "title-url"],
  [MENU_IDS.MARKDOWN, "markdown"]
]);

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingContextMenus = null;
let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus().catch((error) => {
    console.error("[TabGrab] Context menu initialization failed:", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((error) => {
    console.error("[TabGrab] Copy failed:", error);
  });
});

function createContextMenus() {
  if (!creatingContextMenus) {
    creatingContextMenus = resetContextMenus().finally(() => {
      creatingContextMenus = null;
    });
  }

  return creatingContextMenus;
}

async function resetContextMenus() {
  await removeAllContextMenus();

  await createContextMenu({
    id: MENU_IDS.ROOT,
    title: "TabGrab",
    contexts: ["tab"]
  });

  await createContextMenu({
    id: MENU_IDS.URL,
    parentId: MENU_IDS.ROOT,
    title: "Copy URLs",
    contexts: ["tab"]
  });

  await createContextMenu({
    id: MENU_IDS.TITLE_URL,
    parentId: MENU_IDS.ROOT,
    title: "Copy Title + URLs",
    contexts: ["tab"]
  });

  await createContextMenu({
    id: MENU_IDS.MARKDOWN,
    parentId: MENU_IDS.ROOT,
    title: "Copy as Markdown",
    contexts: ["tab"]
  });
}

function removeAllContextMenus() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function createContextMenu(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

async function getSelectedTabs(windowId) {
  const query = Number.isInteger(windowId)
    ? { windowId, highlighted: true }
    : { currentWindow: true, highlighted: true };
  const tabs = await chrome.tabs.query(query);

  return tabs
    .filter((tab) => typeof tab.url === "string" && tab.url.trim())
    .sort((first, second) => getTabIndex(first) - getTabIndex(second));
}

function getTabIndex(tab) {
  return Number.isInteger(tab.index) ? tab.index : Number.MAX_SAFE_INTEGER;
}

function formatTabs(tabs, format) {
  const copyableTabs = tabs.filter((tab) => typeof tab.url === "string" && tab.url.trim());

  switch (format) {
    case "url":
      return copyableTabs.map((tab) => tab.url).join("\n");
    case "title-url":
      return copyableTabs.map(formatTitleUrl).join("\n\n");
    case "markdown":
      return copyableTabs.map(formatMarkdown).join("\n");
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

function formatTitleUrl(tab) {
  const title = getTabTitle(tab);
  return title ? `${title}\n${tab.url}` : tab.url;
}

function formatMarkdown(tab) {
  const title = getTabTitle(tab) || tab.url;
  return `[${escapeMarkdownTitle(title)}](${escapeMarkdownUrl(tab.url)})`;
}

function getTabTitle(tab) {
  return typeof tab.title === "string" && tab.title.trim() ? tab.title : "";
}

function escapeMarkdownTitle(title) {
  return String(title).replace(/([\\\[\]])/g, "\\$1");
}

function escapeMarkdownUrl(url) {
  return String(url)
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s/g, "%20");
}

async function handleContextMenuClick(info, tab) {
  const format = FORMATS_BY_MENU_ID.get(info.menuItemId);
  if (!format) {
    return false;
  }

  const tabs = await getSelectedTabs(tab?.windowId);
  const text = formatTabs(tabs, format);
  if (!text) {
    console.error("[TabGrab] No valid URLs found.");
    return false;
  }

  await copyToClipboard(text);
  return true;
}

async function copyToClipboard(text) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ type: "tabgrab-copy", text });

  if (!response?.ok) {
    throw new Error(response?.error || "Clipboard write failed.");
  }
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["CLIPBOARD"],
      justification: "Copy selected tab URLs to the clipboard."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}
