"use strict";

const VALID_FORMATS = new Set(["url", "title-url", "markdown"]);

const state = {
  tabs: [],
  selectedTabIds: new Set(),
  searchQuery: "",
  copyFormat: "url",
  lastClickedTabId: null,
  feedbackTimer: null,
  loadError: ""
};

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();

  await Promise.all([loadSettings(), loadTabs()]);
  elements.formatSelect.value = state.copyFormat;
  renderTabs();
}

function cacheElements() {
  elements.tabList = document.querySelector("#tab-list");
  elements.searchInput = document.querySelector("#search-input");
  elements.selectedCount = document.querySelector("#selected-count");
  elements.selectAllButton = document.querySelector("#select-all-button");
  elements.deselectAllButton = document.querySelector("#deselect-all-button");
  elements.formatSelect = document.querySelector("#format-select");
  elements.copyButton = document.querySelector("#copy-button");
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.searchQuery = event.target.value.trim().toLocaleLowerCase();
    state.lastClickedTabId = null;
    renderTabs();
  });

  elements.selectAllButton.addEventListener("click", selectAllVisible);
  elements.deselectAllButton.addEventListener("click", deselectAll);
  elements.formatSelect.addEventListener("change", handleFormatChange);
  elements.copyButton.addEventListener("click", copySelectedTabs);

  elements.tabList.addEventListener("click", (event) => {
    const domainButton = event.target.closest(".domain-button");
    if (domainButton) {
      selectDomain(domainButton.dataset.domain);
      return;
    }

    const checkbox = event.target.closest(".tab-checkbox");
    if (!checkbox) {
      return;
    }

    toggleTabSelection(Number(checkbox.dataset.tabId), checkbox.checked, event.shiftKey);
  });

  elements.tabList.addEventListener("error", handleFaviconError, true);
}

async function loadTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    state.tabs = tabs
      .map(normalizeTab)
      .sort((first, second) => first.index - second.index);

    const highlightedTabs = state.tabs.filter((tab) => tab.highlighted);
    const initiallySelectedTabs = highlightedTabs.length > 0
      ? highlightedTabs
      : state.tabs.filter((tab) => tab.active);
    initiallySelectedTabs.forEach((tab) => state.selectedTabIds.add(tab.id));
  } catch (error) {
    console.error("Unable to load tabs:", error);
    state.tabs = [];
    state.loadError = "Unable to load tabs.";
  }
}

function normalizeTab(tab) {
  const url = typeof tab.url === "string" ? tab.url : "";
  return {
    id: tab.id,
    index: Number.isInteger(tab.index) ? tab.index : 0,
    title: typeof tab.title === "string" && tab.title.trim() ? tab.title : "Untitled tab",
    url,
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    active: Boolean(tab.active),
    highlighted: Boolean(tab.highlighted),
    domain: getDomain(url)
  };
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get("copyFormat");
    state.copyFormat = VALID_FORMATS.has(result.copyFormat) ? result.copyFormat : "url";
  } catch (error) {
    console.error("Unable to load copy format:", error);
    state.copyFormat = "url";
  }
}

async function handleFormatChange(event) {
  const format = event.target.value;
  state.copyFormat = VALID_FORMATS.has(format) ? format : "url";

  try {
    await chrome.storage.local.set({ copyFormat: state.copyFormat });
  } catch (error) {
    console.error("Unable to save copy format:", error);
  }
}

function getDomain(url) {
  if (!url) {
    return "URL unavailable";
  }

  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLocaleLowerCase();

    if (protocol === "http:" || protocol === "https:") {
      return parsed.hostname || "Unknown host";
    }

    if (["chrome:", "edge:", "brave:", "chrome-extension:"].includes(protocol)) {
      return parsed.hostname ? `${protocol}//${parsed.hostname}` : protocol;
    }

    if (protocol === "file:") {
      return parsed.hostname ? `file://${parsed.hostname}` : "file://";
    }

    if (protocol === "about:") {
      return "about:";
    }

    return parsed.hostname || protocol || "Unknown host";
  } catch (error) {
    const schemeMatch = url.match(/^([a-z][a-z\d+.-]*:)/i);
    return schemeMatch ? schemeMatch[1].toLocaleLowerCase() : "Unknown host";
  }
}

function getVisibleTabs() {
  if (!state.searchQuery) {
    return state.tabs;
  }

  return state.tabs.filter((tab) => {
    const searchableText = `${tab.title}\n${tab.url}\n${tab.domain}`.toLocaleLowerCase();
    return searchableText.includes(state.searchQuery);
  });
}

function renderTabs() {
  const visibleTabs = getVisibleTabs();
  elements.tabList.replaceChildren();

  if (visibleTabs.length === 0) {
    showEmptyState(
      state.loadError || (state.tabs.length === 0 ? "No tabs found." : "No matching tabs."),
      Boolean(state.loadError)
    );
    updateSelectionUI();
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleTabs.forEach((tab) => fragment.append(createTabRow(tab)));
  elements.tabList.append(fragment);
  updateSelectionUI();
}

function createTabRow(tab) {
  const row = document.createElement("article");
  row.className = "tab-row";
  row.dataset.tabId = String(tab.id);
  row.classList.toggle("is-selected", state.selectedTabIds.has(tab.id));

  const checkbox = document.createElement("input");
  checkbox.className = "tab-checkbox";
  checkbox.type = "checkbox";
  checkbox.checked = state.selectedTabIds.has(tab.id);
  checkbox.dataset.tabId = String(tab.id);
  checkbox.setAttribute("aria-label", `Select ${tab.title}`);

  const favicon = createFavicon(tab);

  const details = document.createElement("div");
  details.className = "tab-details";

  const title = document.createElement("div");
  title.className = "tab-title";
  title.title = tab.title;
  title.textContent = tab.title;

  const domain = document.createElement("button");
  domain.className = "domain-button";
  domain.type = "button";
  domain.dataset.domain = tab.domain;
  domain.title = `Select all tabs from ${tab.domain}`;
  domain.setAttribute("aria-label", `Select all tabs from ${tab.domain}`);
  domain.textContent = tab.domain;

  details.append(title, domain);
  row.append(checkbox, favicon, details);
  return row;
}

function createFavicon(tab) {
  if (!isSafeFaviconUrl(tab.favIconUrl)) {
    return createFaviconFallback(tab.title);
  }

  const image = document.createElement("img");
  image.className = "favicon";
  image.src = tab.favIconUrl;
  image.alt = "";
  image.width = 24;
  image.height = 24;
  image.dataset.fallback = getFallbackCharacter(tab.title);
  return image;
}

function isSafeFaviconUrl(url) {
  if (!url) {
    return false;
  }

  try {
    return ["http:", "https:", "data:", "blob:", "chrome-extension:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function handleFaviconError(event) {
  if (!event.target.classList.contains("favicon")) {
    return;
  }

  const fallback = createFaviconFallback(event.target.dataset.fallback);
  event.target.replaceWith(fallback);
}

function createFaviconFallback(title) {
  const fallback = document.createElement("span");
  fallback.className = "favicon-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = getFallbackCharacter(title);
  return fallback;
}

function getFallbackCharacter(title) {
  const character = String(title || "").trim().charAt(0);
  return character && /[\p{L}\p{N}]/u.test(character) ? character : "↗";
}

function showEmptyState(message, isError = false) {
  const emptyState = document.createElement("div");
  emptyState.className = "empty-state";
  emptyState.classList.toggle("is-error", isError);
  emptyState.textContent = message;
  elements.tabList.replaceChildren(emptyState);
}

function toggleTabSelection(tabId, selected, useRange) {
  const visibleTabs = getVisibleTabs();
  const currentIndex = visibleTabs.findIndex((tab) => tab.id === tabId);

  if (useRange && state.lastClickedTabId !== null && currentIndex >= 0) {
    const lastIndex = visibleTabs.findIndex((tab) => tab.id === state.lastClickedTabId);
    if (lastIndex >= 0) {
      const start = Math.min(lastIndex, currentIndex);
      const end = Math.max(lastIndex, currentIndex);
      visibleTabs.slice(start, end + 1).forEach((tab) => setTabSelection(tab.id, selected));
    } else {
      setTabSelection(tabId, selected);
    }
  } else {
    setTabSelection(tabId, selected);
  }

  state.lastClickedTabId = tabId;
  syncRenderedSelection();
}

function setTabSelection(tabId, selected) {
  if (selected) {
    state.selectedTabIds.add(tabId);
  } else {
    state.selectedTabIds.delete(tabId);
  }
}

function selectAllVisible() {
  getVisibleTabs().forEach((tab) => state.selectedTabIds.add(tab.id));
  syncRenderedSelection();
}

function deselectAll() {
  state.selectedTabIds.clear();
  state.lastClickedTabId = null;
  syncRenderedSelection();
}

function selectDomain(domain) {
  state.tabs
    .filter((tab) => tab.domain === domain)
    .forEach((tab) => state.selectedTabIds.add(tab.id));
  syncRenderedSelection();
}

function syncRenderedSelection() {
  elements.tabList.querySelectorAll(".tab-row").forEach((row) => {
    const tabId = Number(row.dataset.tabId);
    const selected = state.selectedTabIds.has(tabId);
    row.classList.toggle("is-selected", selected);
    row.querySelector(".tab-checkbox").checked = selected;
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  const selectedCount = state.selectedTabIds.size;
  const visibleTabs = getVisibleTabs();
  const allVisibleSelected = visibleTabs.length > 0
    && visibleTabs.every((tab) => state.selectedTabIds.has(tab.id));

  elements.selectedCount.textContent = `Selected: ${selectedCount}`;
  elements.copyButton.disabled = selectedCount === 0;
  elements.copyButton.textContent = selectedCount === 0
    ? "Copy URLs"
    : `Copy ${selectedCount} ${selectedCount === 1 ? "URL" : "URLs"}`;
  elements.selectAllButton.disabled = visibleTabs.length === 0 || allVisibleSelected;
  elements.deselectAllButton.disabled = selectedCount === 0;
}

async function copySelectedTabs() {
  const selectedTabs = state.tabs.filter((tab) => state.selectedTabIds.has(tab.id));
  if (selectedTabs.length === 0) {
    return;
  }

  const separator = state.copyFormat === "title-url" ? "\n\n" : "\n";
  const text = selectedTabs.map((tab) => formatTab(tab, state.copyFormat)).join(separator);

  try {
    await navigator.clipboard.writeText(text);
    showCopyFeedback(`Copied ${selectedTabs.length} ${selectedTabs.length === 1 ? "URL" : "URLs"}`);
  } catch (error) {
    console.error("Unable to copy URLs:", error);
    showCopyFeedback("Copy failed", true);
  }
}

function formatTab(tab, format) {
  if (format === "title-url") {
    return `${tab.title}\n${tab.url}`;
  }

  if (format === "markdown") {
    return `[${escapeMarkdown(tab.title)}](${escapeMarkdownUrl(tab.url)})`;
  }

  return tab.url;
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\\[\]])/g, "\\$1");
}

function escapeMarkdownUrl(value) {
  return String(value)
    .replace(/\\/g, "%5C")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\s/g, "%20");
}

function showCopyFeedback(message, isError = false) {
  clearTimeout(state.feedbackTimer);
  elements.copyButton.textContent = message;
  elements.copyButton.classList.toggle("is-error", isError);

  state.feedbackTimer = setTimeout(() => {
    elements.copyButton.classList.remove("is-error");
    updateSelectionUI();
  }, 1800);
}
