import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CDP_BASE = process.env.EDGE_CDP_URL || "http://127.0.0.1:9222";
const EXTENSION_NAME = "TabGrab";
const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_URLS = [
  "https://example.com/",
  "https://www.wikipedia.org/",
  "https://github.com/",
  "https://github.com/openai/"
];

class CDPConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${webSocketUrl}`)), { once: true });
    });
    return new CDPConnection(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(message);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    for (const listener of this.listeners.get(message.method) || []) {
      listener(message.params || {});
    }
  }

  close() {
    this.socket.close();
  }
}

const results = [];
const unexpectedErrors = [];
let browser;
let page;
let popupTargetId;

function pass(name) {
  results.push({ status: "PASS", name });
}

function fail(name, error) {
  results.push({ status: "FAIL", name, detail: error instanceof Error ? error.message : String(error) });
}

function skip(name, detail) {
  results.push({ status: "SKIPPED", name, detail });
}

async function test(name, callback) {
  try {
    await callback();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(path) {
  const response = await fetch(`${CDP_BASE}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

async function waitFor(callback, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectToTarget(targetId) {
  const target = await waitFor(async () => {
    const targets = await getJson("/json");
    return targets.find((candidate) => candidate.id === targetId && candidate.webSocketDebuggerUrl);
  }, `target ${targetId}`);
  return CDPConnection.connect(target.webSocketDebuggerUrl);
}

async function evaluate(expression, awaitPromise = true) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function createTarget(url) {
  const { targetId } = await browser.send("Target.createTarget", { url });
  return targetId;
}

async function closeTarget(targetId) {
  if (!targetId) return;
  try {
    await browser.send("Target.closeTarget", { targetId });
  } catch {
    // A target may already have closed during a failed test.
  }
}

async function discoverExtensionId() {
  try {
    const { extensions } = await browser.send("Extensions.getExtensions");
    const installed = extensions.find((extension) => extension.name === EXTENSION_NAME);
    if (installed) return installed.id;

    const { id } = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    return id;
  } catch (error) {
    if (!error.message.includes("wasn't found") && !error.message.includes("not allowed")) {
      throw error;
    }
  }

  const existingTargets = await getJson("/json");
  const popupTarget = existingTargets.find((target) => {
    return target.url?.includes("/popup.html") && target.url.startsWith("chrome-extension://");
  });
  if (popupTarget) return new URL(popupTarget.url).hostname;

  const extensionsTargetId = await createTarget("edge://extensions/");
  const extensionsPage = await connectToTarget(extensionsTargetId);
  await extensionsPage.send("Runtime.enable");

  try {
    return await waitFor(async () => {
      const result = await extensionsPage.send("Runtime.evaluate", {
        expression: `(() => {
          const elements = [];
          const scan = (root) => {
            for (const element of root.querySelectorAll("*")) {
              elements.push(element);
              if (element.shadowRoot) scan(element.shadowRoot);
            }
          };
          scan(document);
          return elements
            .filter((element) => element.tagName === "EXTENSIONS-ITEM")
            .map((element) => ({
              id: element.id || element.getAttribute("id") || "",
              text: (element.shadowRoot?.textContent || element.textContent || "").replace(/\\s+/g, " ").trim()
            }));
        })()`,
        returnByValue: true
      });
      const items = result.result?.value || [];
      return items.find((item) => item.text.includes(EXTENSION_NAME))?.id;
    }, "extension discovery", 20000);
  } finally {
    extensionsPage.close();
    await closeTarget(extensionsTargetId);
  }
}

async function openPopup(extensionId, actionTargetId) {
  try {
    await browser.send("Extensions.triggerAction", { id: extensionId, targetId: actionTargetId });
    popupTargetId = await waitFor(async () => {
      const targets = await getJson("/json");
      return targets.find((target) => target.url === `chrome-extension://${extensionId}/popup.html`)?.id;
    }, "action popup target", 5000);
  } catch {
    popupTargetId = await createTarget(`chrome-extension://${extensionId}/popup.html`);
  }
  page = await connectToTarget(popupTargetId);
  await Promise.all([
    page.send("Runtime.enable"),
    page.send("Log.enable"),
    page.send("Page.enable")
  ]);

  page.on("Runtime.exceptionThrown", (params) => {
    unexpectedErrors.push(params.exceptionDetails?.exception?.description || "Runtime.exceptionThrown");
  });
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      unexpectedErrors.push(params.args?.map((arg) => arg.value || arg.description).join(" ") || "console.error");
    }
  });
  page.on("Log.entryAdded", (params) => {
    if (params.entry?.level === "error") unexpectedErrors.push(params.entry.text);
  });

  await waitFor(
    () => evaluate("document.readyState === 'complete' && document.querySelectorAll('.tab-row').length > 0"),
    "popup rendering"
  );
}

async function setHighlightedTabs(extensionId, urls) {
  const preflightTargetId = await createTarget(`chrome-extension://${extensionId}/popup.html?preflight=1`);
  const preflightPage = await connectToTarget(preflightTargetId);
  await preflightPage.send("Runtime.enable");

  try {
    await waitFor(async () => {
      const result = await preflightPage.send("Runtime.evaluate", {
        expression: "chrome.tabs.query({ currentWindow: true }).then((tabs) => tabs.map((tab) => tab.url || ''))",
        awaitPromise: true,
        returnByValue: true
      });
      const tabUrls = new Set(result.result?.value || []);
      return TEST_URLS.every((url) => tabUrls.has(url));
    }, "tabs API navigation state");

    const result = await preflightPage.send("Runtime.evaluate", {
      expression: `(async () => {
        const desiredUrls = ${JSON.stringify(urls)};
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const desiredTabs = desiredUrls.map((url) => tabs.find((tab) => tab.url === url));
        if (desiredTabs.some((tab) => !tab)) throw new Error("Unable to find a tab to highlight");
        await chrome.tabs.highlight({
          windowId: desiredTabs[0].windowId,
          tabs: desiredTabs.map((tab) => tab.index)
        });
        const highlighted = await chrome.tabs.query({ currentWindow: true, highlighted: true });
        return {
          ids: highlighted.map((tab) => tab.id),
          activeUrl: highlighted.find((tab) => tab.active)?.url || ""
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    assert(result.result?.value?.ids?.length === urls.length, "Native highlighted tab count did not match setup");
    return result.result.value;
  } finally {
    preflightPage.close();
    await closeTarget(preflightTargetId);
  }
}

function readSelectedCount(text) {
  return Number(String(text).match(/\d+/)?.[0] || 0);
}

function expectedFormat(tab, format) {
  if (format === "title-url") return `${tab.title}\n${tab.url}`;
  if (format === "markdown") {
    const title = tab.title.replace(/([\\\[\]])/g, "\\$1");
    const url = tab.url
      .replace(/\\/g, "%5C")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\s/g, "%20");
    return `[${title}](${url})`;
  }
  return tab.url;
}

async function main() {
  let specialTargetId;
  try {
    const version = await getJson("/json/version");
    assert(version.webSocketDebuggerUrl, "CDP browser endpoint has no WebSocket URL");
    browser = await CDPConnection.connect(version.webSocketDebuggerUrl);
    await browser.send("Target.setDiscoverTargets", { discover: true });

    const targets = await getJson("/json");
    console.log(`Connected to ${version.Browser || "Microsoft Edge"}; ${targets.length} initial targets`);

    let extensionId;
    await test("Extension loaded", async () => {
      extensionId = await discoverExtensionId();
      assert(/^[a-p]{32}$/.test(extensionId), `Invalid discovered extension ID: ${extensionId}`);
    });

    if (!extensionId) {
      [
        "Popup rendered", "Highlighted tabs selected", "Single highlighted tab selected", "Individual selection", "Search",
        "Select All Visible", "Deselect All", "Domain selection", "Format persistence",
        "Copy formatting", "Special URL handling", "Compact adaptive layout", "No uncaught exceptions"
      ].forEach((name) => skip(name, "Extension discovery failed"));
      return;
    }

    const testTargetIds = [];
    for (const url of TEST_URLS) testTargetIds.push(await createTarget(url));
    try {
      specialTargetId = await createTarget("edge://version/");
    } catch {
      specialTargetId = null;
    }

    await waitFor(async () => {
      const targetUrls = new Set((await getJson("/json")).map((target) => target.url));
      return TEST_URLS.every((url) => targetUrls.has(url));
    }, "test tab navigation");
    const nativeSelection = await setHighlightedTabs(
      extensionId,
      ["https://github.com/", "https://github.com/openai/"]
    );

    const activeTargetIndex = TEST_URLS.indexOf(nativeSelection.activeUrl);
    assert(activeTargetIndex >= 0, `Highlighted active tab was unexpected: ${nativeSelection.activeUrl}`);
    await openPopup(extensionId, testTargetIds[activeTargetIndex]);

    await test("Popup rendered", async () => {
      const dom = await evaluate(`({
        rows: document.querySelectorAll(".tab-row").length,
        search: Boolean(document.querySelector("#search-input")),
        selectAll: Boolean(document.querySelector("#select-all-button")),
        deselectAll: Boolean(document.querySelector("#deselect-all-button")),
        format: Boolean(document.querySelector("#format-select")),
        copy: Boolean(document.querySelector("#copy-button"))
      })`);
      assert(dom.rows >= TEST_URLS.length, `Expected at least ${TEST_URLS.length} rows, got ${dom.rows}`);
      assert(dom.search && dom.selectAll && dom.deselectAll && dom.format && dom.copy, "Required popup control is missing");
    });

    try {
      const selection = await evaluate(`(async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const highlighted = tabs.filter((tab) => tab.highlighted).map((tab) => tab.id).sort((a, b) => a - b);
        const checked = [...document.querySelectorAll(".tab-checkbox:checked")].map((item) => Number(item.dataset.tabId));
        checked.sort((a, b) => a - b);
        return {
          highlighted,
          checked,
          label: document.querySelector("#selected-count").textContent,
          copyText: document.querySelector("#copy-button").textContent
        };
      })()`);
      if (nativeSelection.ids.length === 2 && selection.highlighted.length === 1) {
        skip(
          "Highlighted tabs selected",
          "Edge CDP Extensions.triggerAction collapsed the native multi-tab highlight before popup initialization"
        );
      } else {
      assert(selection.highlighted.length === 2, `Expected two highlighted tabs, got ${selection.highlighted.length}`);
      assert(selection.checked.length === 2, `Expected two selected rows, got ${selection.checked.length}`);
      assert(JSON.stringify(selection.checked) === JSON.stringify(selection.highlighted), "Selected rows do not match highlighted tabs");
      assert(readSelectedCount(selection.label) === 2, "Selected count is not 2");
      assert(selection.copyText.includes("2"), "Copy button does not show two URLs");
        pass("Highlighted tabs selected");
      }
    } catch (error) {
      fail("Highlighted tabs selected", error);
    }

    await test("Single highlighted tab selected", async () => {
      page.close();
      await closeTarget(popupTargetId);
      await setHighlightedTabs(extensionId, ["https://example.com/"]);
      await openPopup(extensionId, testTargetIds[0]);
      const selection = await evaluate(`(async () => {
        const highlighted = (await chrome.tabs.query({ currentWindow: true, highlighted: true })).map((tab) => tab.id);
        const checked = [...document.querySelectorAll(".tab-checkbox:checked")].map((item) => Number(item.dataset.tabId));
        return { highlighted, checked, label: document.querySelector("#selected-count").textContent };
      })()`);
      assert(selection.highlighted.length === 1, `Expected one highlighted tab, got ${selection.highlighted.length}`);
      assert(selection.checked.length === 1, `Expected one selected row, got ${selection.checked.length}`);
      assert(selection.checked[0] === selection.highlighted[0], "Single selected row does not match the highlighted tab");
      assert(readSelectedCount(selection.label) === 1, "Selected count is not 1");
    });

    await test("Individual selection", async () => {
      const before = await evaluate("Number(document.querySelector('#selected-count').textContent.match(/\\d+/)[0])");
      const after = await evaluate(`(() => {
        const checkbox = document.querySelector(".tab-checkbox:not(:checked)");
        checkbox.click();
        return {
          checked: checkbox.checked,
          count: Number(document.querySelector("#selected-count").textContent.match(/\\d+/)[0]),
          copyText: document.querySelector("#copy-button").textContent
        };
      })()`);
      assert(after.checked, "Checkbox did not become checked");
      assert(after.count === before + 1, "Selected count did not increment");
      assert(after.copyText.includes(String(after.count)), "Copy button count did not update");
    });

    await test("Search", async () => {
      const result = await evaluate(`(() => {
        const before = document.querySelector("#selected-count").textContent;
        const beforeDomains = [...document.querySelectorAll(".domain-button")].map((item) => item.textContent);
        const input = document.querySelector("#search-input");
        input.value = "github";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return {
          before,
          after: document.querySelector("#selected-count").textContent,
          domains: [...document.querySelectorAll(".domain-button")].map((item) => item.textContent),
          beforeDomains
        };
      })()`);
      assert(
        result.domains.length >= 2,
        `Expected at least two GitHub rows, got ${result.domains.length}; initial domains: ${result.beforeDomains.join(", ")}`
      );
      assert(result.domains.every((domain) => domain.includes("github.com")), "Search left a non-GitHub row visible");
      assert(result.before === result.after, "Search changed selection state");
    });

    await test("Select All Visible", async () => {
      const result = await evaluate(`(() => {
        document.querySelector("#deselect-all-button").click();
        const visible = document.querySelectorAll(".tab-checkbox").length;
        document.querySelector("#select-all-button").click();
        return {
          visible,
          checked: document.querySelectorAll(".tab-checkbox:checked").length,
          count: Number(document.querySelector("#selected-count").textContent.match(/\\d+/)[0])
        };
      })()`);
      assert(result.visible >= 2, "GitHub search did not expose two rows");
      assert(result.checked === result.visible, "Not all visible rows were selected");
      assert(result.count === result.visible, "A hidden row was selected by Select All");
    });

    await test("Deselect All", async () => {
      const result = await evaluate(`(() => {
        document.querySelector("#deselect-all-button").click();
        return {
          count: document.querySelector("#selected-count").textContent,
          checked: document.querySelectorAll(".tab-checkbox:checked").length,
          disabled: document.querySelector("#copy-button").disabled
        };
      })()`);
      assert(readSelectedCount(result.count) === 0, "Selected count is not zero");
      assert(result.checked === 0, "A checkbox remains selected");
      assert(result.disabled, "Copy button is enabled with zero selections");
    });

    await test("Domain selection", async () => {
      const result = await evaluate(`(() => {
        const input = document.querySelector("#search-input");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const github = [...document.querySelectorAll(".domain-button")]
          .find((item) => item.textContent === "github.com");
        github.click();
        const githubRows = [...document.querySelectorAll(".tab-row")]
          .filter((row) => row.querySelector(".domain-button").textContent === "github.com");
        return {
          githubRows: githubRows.length,
          selected: githubRows.filter((row) => row.querySelector(".tab-checkbox").checked).length
        };
      })()`);
      assert(result.githubRows >= 2, "Expected two github.com rows");
      assert(result.selected === result.githubRows, "Domain click did not select every matching tab");
    });

    await test("Format persistence", async () => {
      await evaluate(`(() => {
        const select = document.querySelector("#format-select");
        select.value = "markdown";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await waitFor(() => evaluate("chrome.storage.local.get('copyFormat').then((value) => value.copyFormat === 'markdown')"), "format storage");

      page.close();
      await closeTarget(popupTargetId);
      await openPopup(extensionId, testTargetIds.at(-1));
      const format = await evaluate("document.querySelector('#format-select').value");
      assert(format === "markdown", `Expected persisted markdown format, got ${format}`);
    });

    await test("Copy formatting", async () => {
      await evaluate(`(() => {
        const clipboard = { writeText: async (text) => { globalThis.__copiedText = text; } };
        Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
        document.querySelector("#deselect-all-button").click();
        const github = [...document.querySelectorAll(".domain-button")]
          .find((item) => item.textContent === "github.com");
        github.click();
      })()`);

      const selectedTabs = await evaluate(`(async () => {
        const ids = new Set([...document.querySelectorAll(".tab-checkbox:checked")]
          .map((item) => Number(item.dataset.tabId)));
        return (await chrome.tabs.query({ currentWindow: true }))
          .filter((tab) => ids.has(tab.id))
          .sort((a, b) => a.index - b.index)
          .map((tab) => ({ title: tab.title || "Untitled tab", url: tab.url || "" }));
      })()`);
      assert(selectedTabs.length >= 2, "Copy test has fewer than two selected tabs");

      for (const format of ["url", "title-url", "markdown"]) {
        const actual = await evaluate(`(async () => {
          const select = document.querySelector("#format-select");
          select.value = ${JSON.stringify(format)};
          select.dispatchEvent(new Event("change", { bubbles: true }));
          globalThis.__copiedText = null;
          document.querySelector("#copy-button").click();
          for (let attempt = 0; attempt < 20 && globalThis.__copiedText === null; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return globalThis.__copiedText;
        })()`);
        const separator = format === "title-url" ? "\n\n" : "\n";
        const expected = selectedTabs.map((tab) => expectedFormat(tab, format)).join(separator);
        assert(actual === expected, `${format} clipboard output did not match expected text`);
      }
    });

    if (!specialTargetId) {
      skip("Special URL handling", "Edge refused to create an edge://version/ target");
    } else {
      await test("Special URL handling", async () => {
        const result = await evaluate(`(() => {
          const input = document.querySelector("#search-input");
          input.value = "edge://version";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return [...document.querySelectorAll(".domain-button")].map((item) => item.textContent);
        })()`);
        assert(result.includes("edge://version"), "edge://version tab was not rendered safely");
      });
    }

    await test("Compact adaptive layout", async () => {
      const layout = await evaluate(`(async () => {
        const initialHeight = document.body.getBoundingClientRect().height;
        const list = document.querySelector("#tab-list");
        const sourceRow = list.querySelector(".tab-row");
        for (let index = 0; index < 12; index += 1) list.append(sourceRow.cloneNode(true));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const app = document.querySelector(".app").getBoundingClientRect();
        const header = document.querySelector(".header").getBoundingClientRect();
        const footer = document.querySelector(".footer").getBoundingClientRect();
        return {
          initialHeight,
          expandedHeight: document.body.getBoundingClientRect().height,
          listScrolls: list.scrollHeight > list.clientHeight,
          headerVisible: header.top >= app.top,
          footerVisible: footer.bottom <= app.bottom + 1
        };
      })()`);
      assert(layout.initialHeight < 600, `Small popup remained ${layout.initialHeight}px tall`);
      assert(layout.expandedHeight <= 600, `Expanded popup exceeded 600px: ${layout.expandedHeight}px`);
      assert(layout.listScrolls, "Long tab list did not become scrollable");
      assert(layout.headerVisible && layout.footerVisible, "Header or footer moved outside the popup viewport");
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await test("No uncaught exceptions", async () => {
      assert(unexpectedErrors.length === 0, unexpectedErrors.join(" | "));
    });
  } catch (error) {
    fail("CDP test setup", error);
  } finally {
    page?.close();
    await closeTarget(popupTargetId);
    browser?.close();
  }
}

await main();

console.log("\nEdge CDP Integration Tests\n");
for (const result of results) {
  console.log(`${result.status} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}

const counts = results.reduce((summary, result) => {
  summary[result.status] = (summary[result.status] || 0) + 1;
  return summary;
}, { PASS: 0, FAIL: 0, SKIPPED: 0 });

console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIPPED} skipped`);
if (counts.FAIL > 0) process.exitCode = 1;
