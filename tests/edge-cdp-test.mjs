import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CDP_BASE = process.env.EDGE_CDP_URL || "http://127.0.0.1:9333";
const EXTENSION_NAME = "TabGrab";
const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_URLS = [
  "https://example.com/",
  "https://www.wikipedia.org/",
  "https://github.com/",
  "https://github.com/openai/",
  "https://openai.com/"
];

class CDPConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolveConnection, reject) => {
      socket.addEventListener("open", resolveConnection, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${webSocketUrl}`)), { once: true });
    });
    return new CDPConnection(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
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
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result || {});
      return;
    }

    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  close() {
    this.socket.close();
  }
}

const results = [];
const runtimeErrors = [];
const createdTargetIds = [];
let browser;
let worker;
let offscreen;
let popup;
let popupTargetId;

function record(status, name, detail = "") {
  results.push({ status, name, detail });
}

async function test(name, callback) {
  try {
    await callback();
    record("PASS", name);
  } catch (error) {
    record("FAIL", name, error instanceof Error ? error.message : String(error));
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
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }

  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectToTarget(targetId) {
  const target = await waitFor(async () => {
    return (await getJson("/json")).find((candidate) => candidate.id === targetId && candidate.webSocketDebuggerUrl);
  }, `target ${targetId}`);
  return CDPConnection.connect(target.webSocketDebuggerUrl);
}

async function createTarget(url) {
  const { targetId } = await browser.send("Target.createTarget", { url });
  createdTargetIds.push(targetId);
  return targetId;
}

async function closeTarget(targetId) {
  try {
    await browser?.send("Target.closeTarget", { targetId });
  } catch {
    // A failed test may already have closed the target.
  }
}

async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

function monitorRuntime(connection, source) {
  connection.on("Runtime.exceptionThrown", (params) => {
    runtimeErrors.push(`${source}: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
  });
  connection.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    const text = params.args?.map((argument) => argument.value || argument.description).join(" ") || "console.error";
    runtimeErrors.push(`${source}: ${text}`);
  });
  connection.on("Log.entryAdded", (params) => {
    if (params.entry?.level === "error") runtimeErrors.push(`${source}: ${params.entry.text}`);
  });
}

async function discoverExtensionId() {
  try {
    const loaded = await browser.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
    if (loaded.id) return loaded.id;

    const { extensions } = await browser.send("Extensions.getExtensions");
    const installed = extensions.find((extension) => extension.name === EXTENSION_NAME);
    if (installed) return installed.id;
  } catch (error) {
    const target = (await getJson("/json")).find((candidate) => {
      return candidate.url?.startsWith("chrome-extension://") && candidate.url.endsWith("/background.js");
    });
    if (target) return new URL(target.url).hostname;
    throw new Error(`Unable to load or discover TabGrab: ${error.message}`);
  }
}

async function connectToExtensionWorker(extensionId) {
  const target = await waitFor(async () => {
    return (await getJson("/json")).find((candidate) => {
      return candidate.type === "service_worker"
        && candidate.url === `chrome-extension://${extensionId}/background.js`;
    });
  }, "TabGrab service worker", 20000);

  const connection = await CDPConnection.connect(target.webSocketDebuggerUrl);
  await Promise.all([connection.send("Runtime.enable"), connection.send("Log.enable")]);
  monitorRuntime(connection, "service worker");
  return connection;
}

async function connectToOffscreen(extensionId) {
  const target = await waitFor(async () => {
    return (await getJson("/json")).find((candidate) => {
      return candidate.url === `chrome-extension://${extensionId}/offscreen.html`;
    });
  }, "TabGrab offscreen document");

  const connection = await CDPConnection.connect(target.webSocketDebuggerUrl);
  await Promise.all([connection.send("Runtime.enable"), connection.send("Log.enable")]);
  monitorRuntime(connection, "offscreen document");
  return connection;
}

async function openToolbarPopup(extensionId, actionTargetId) {
  try {
    await browser.send("Extensions.triggerAction", { id: extensionId, targetId: actionTargetId });
    popupTargetId = await waitFor(async () => {
      return (await getJson("/json")).find((candidate) => {
        return candidate.url === `chrome-extension://${extensionId}/popup.html`;
      })?.id;
    }, "TabGrab toolbar popup", 5000);
  } catch {
    popupTargetId = await createTarget(`chrome-extension://${extensionId}/popup.html`);
  }

  const connection = await connectToTarget(popupTargetId);
  await Promise.all([
    connection.send("Runtime.enable"),
    connection.send("Log.enable"),
    connection.send("Page.enable")
  ]);
  monitorRuntime(connection, "toolbar popup");
  await waitFor(
    () => evaluate(connection, "document.readyState === 'complete' && document.querySelectorAll('.tab-row').length > 0"),
    "toolbar popup rendering"
  );
  return connection;
}

async function readSystemClipboard() {
  if (process.platform === "darwin") {
    return (await execFileAsync("pbpaste", [], { encoding: "utf8" })).stdout;
  }
  if (process.platform === "win32") {
    return (await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
      { encoding: "utf8" }
    )).stdout.replace(/\r?\n$/, "");
  }
  throw new Error(`Clipboard reading is not configured for ${process.platform}`);
}

async function main() {
  let extensionId;

  try {
    await test("Microsoft Edge CDP connection", async () => {
      const version = await getJson("/json/version");
      assert(version.Browser?.startsWith("Edg/"), `Expected Microsoft Edge, got ${version.Browser || "unknown"}`);
      assert(version.webSocketDebuggerUrl, "Browser WebSocket URL is missing");
      browser = await CDPConnection.connect(version.webSocketDebuggerUrl);
      await browser.send("Target.setDiscoverTargets", { discover: true });
    });

    if (!browser) throw new Error("Microsoft Edge CDP connection failed");

    await test("Extension loaded", async () => {
      extensionId = await discoverExtensionId();
      assert(/^[a-p]{32}$/.test(extensionId), `Invalid extension ID: ${extensionId}`);
    });
    if (!extensionId) throw new Error("Extension discovery failed");

    await test("Service worker available", async () => {
      worker = await connectToExtensionWorker(extensionId);
    });
    if (!worker) throw new Error("Service worker connection failed");

    await test("Context menus initialized", async () => {
      await evaluate(worker, "createContextMenus().then(() => true)");
    });

    for (const url of TEST_URLS) await createTarget(url);
    await waitFor(async () => {
      const urls = new Set((await getJson("/json")).map((target) => target.url));
      return TEST_URLS.every((url) => urls.has(url));
    }, "test tab navigation", 20000);

    await test("Multiple highlighted tabs queried in tab-strip order", async () => {
      const result = await evaluate(worker, `(async () => {
        const wanted = [${JSON.stringify(TEST_URLS[2])}, ${JSON.stringify(TEST_URLS[0])}, ${JSON.stringify(TEST_URLS[1])}];
        const tabs = await chrome.tabs.query({});
        const selected = wanted.map((url) => tabs.find((tab) => tab.url === url));
        if (selected.some((tab) => !tab)) throw new Error("Test tab was not found");
        await chrome.tabs.highlight({
          windowId: selected[0].windowId,
          tabs: selected.map((tab) => tab.index)
        });
        const queried = await getSelectedTabs(selected[0].windowId);
        return queried.map((tab) => ({ index: tab.index, url: tab.url }));
      })()`);
      assert(result.length === 3, `Expected 3 highlighted tabs, got ${result.length}`);
      assert(result.every((tab, index) => index === 0 || result[index - 1].index < tab.index), "Tabs are not index-sorted");
      assert(new Set(result.map((tab) => tab.url)).size === 3, "Highlighted result contains duplicates");
    });

    await test("Single highlighted tab queried", async () => {
      const result = await evaluate(worker, `(async () => {
        const tabs = await chrome.tabs.query({});
        const selected = tabs.find((tab) => tab.url === ${JSON.stringify(TEST_URLS[1])});
        await chrome.tabs.highlight({ windowId: selected.windowId, tabs: [selected.index] });
        return (await getSelectedTabs(selected.windowId)).map((tab) => tab.url);
      })()`);
      assert(JSON.stringify(result) === JSON.stringify([TEST_URLS[1]]), `Unexpected single selection: ${result}`);
    });

    await test("All copy formats and Markdown escaping", async () => {
      const result = await evaluate(worker, `(() => {
        const tabs = [
          { title: "Test [Page] \\\\ Example", url: "https://example.com/a (b)" },
          { title: "", url: "https://github.com/" },
          { title: "No URL" }
        ];
        return {
          url: formatTabs(tabs, "url"),
          titleUrl: formatTabs(tabs, "title-url"),
          markdown: formatTabs(tabs, "markdown")
        };
      })()`);
      assert(result.url === "https://example.com/a (b)\nhttps://github.com/", "URL format mismatch");
      assert(
        result.titleUrl === "Test [Page] \\ Example\nhttps://example.com/a (b)\n\nhttps://github.com/",
        "Title + URL format mismatch"
      );
      assert(
        result.markdown === "[Test \\[Page\\] \\\\ Example](https://example.com/a%20%28b%29)\n[https://github.com/](https://github.com/)",
        "Markdown format mismatch"
      );
    });

    let specialTargetId;
    try {
      specialTargetId = await createTarget("edge://version/");
    } catch {
      record("SKIPPED", "Special URL handling", "Edge refused to create edge://version/");
    }

    if (specialTargetId) {
      await test("Special URL handling", async () => {
        const result = await evaluate(worker, `(async () => {
          const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === "edge://version/");
          return tab ? formatTabs([tab], "markdown") : "";
        })()`);
        assert(result.startsWith("[") && result.includes("](edge://version/)"), `Unexpected special URL output: ${result}`);
      });
    }

    await test("Offscreen clipboard integration", async () => {
      const text = `TabGrab clipboard ${Date.now()}`;
      await evaluate(worker, `copyToClipboard(${JSON.stringify(text)}).then(() => true)`);
      offscreen = await connectToOffscreen(extensionId);
      const secondText = `${text} verified`;
      await evaluate(worker, `copyToClipboard(${JSON.stringify(secondText)}).then(() => true)`);
      assert(await readSystemClipboard() === secondText, "System clipboard did not contain the expected text");
    });

    await test("Toolbar panel rendered", async () => {
      popup = await openToolbarPopup(extensionId, createdTargetIds[0]);
      const controls = await evaluate(popup, `({
        rows: document.querySelectorAll(".tab-row").length,
        selected: document.querySelectorAll(".tab-checkbox:checked").length,
        search: Boolean(document.querySelector("#search-input")),
        selectAll: Boolean(document.querySelector("#select-all-button")),
        deselectAll: Boolean(document.querySelector("#deselect-all-button")),
        format: Boolean(document.querySelector("#format-select")),
        copy: Boolean(document.querySelector("#copy-button"))
      })`);
      assert(controls.rows >= TEST_URLS.length, `Expected at least ${TEST_URLS.length} rows, got ${controls.rows}`);
      assert(controls.selected >= 1, "Panel did not select a highlighted or active tab initially");
      assert(
        controls.search && controls.selectAll && controls.deselectAll && controls.format && controls.copy,
        "A required toolbar panel control is missing"
      );
    });

    await test("Toolbar panel search and selection", async () => {
      const selection = await evaluate(popup, `(() => {
        const input = document.querySelector("#search-input");
        input.value = "github";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#deselect-all-button").click();
        const visible = document.querySelectorAll(".tab-checkbox").length;
        document.querySelector("#select-all-button").click();
        return {
          visible,
          checked: document.querySelectorAll(".tab-checkbox:checked").length,
          selectedCount: document.querySelector("#selected-count").textContent
        };
      })()`);
      assert(selection.visible >= 1, `Expected at least one GitHub tab, got ${selection.visible}`);
      assert(selection.checked === selection.visible, "Select All did not select every visible search result");
      assert(selection.selectedCount.includes(String(selection.visible)), "Selected count did not update");
    });

    await test("Toolbar panel formatting, persistence, and clipboard", async () => {
      const output = await evaluate(popup, `(async () => {
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async (text) => { globalThis.__panelCopiedText = text; } },
          configurable: true
        });
        const input = document.querySelector("#search-input");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#deselect-all-button").click();
        document.querySelector("#select-all-button").click();
        await handleFormatChange({ target: { value: "markdown" } });
        const tabs = state.tabs.filter((tab) => state.selectedTabIds.has(tab.id));
        const text = tabs.map((tab) => formatTab(tab, "markdown")).join("\\n");
        await copySelectedTabs();
        return { expected: text, copied: globalThis.__panelCopiedText };
      })()`);
      assert(output.expected.split("\n").length >= 2, "Markdown output did not include the selected tabs");
      assert(output.copied === output.expected, "Toolbar panel clipboard output did not match the formatted text");
      const saved = await evaluate(popup, "chrome.storage.local.get('copyFormat').then((value) => value.copyFormat)");
      assert(saved === "markdown", `Expected saved Markdown format, got ${saved}`);
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await test("No unexpected runtime errors", async () => {
      assert(runtimeErrors.length === 0, runtimeErrors.join(" | "));
    });

    record("MANUAL VERIFICATION REQUIRED", "Native Edge Cmd/Ctrl tab-strip selection");
    record("MANUAL VERIFICATION REQUIRED", "Native Edge Shift tab-strip selection");
    record("MANUAL VERIFICATION REQUIRED", "Native Edge right-click selection behavior and submenu UI");
  } catch (error) {
    record("FAIL", "CDP test setup", error instanceof Error ? error.message : String(error));
  } finally {
    for (const targetId of createdTargetIds) await closeTarget(targetId);
    popup?.close();
    if (popupTargetId && !createdTargetIds.includes(popupTargetId)) await closeTarget(popupTargetId);
    offscreen?.close();
    worker?.close();
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
}, { PASS: 0, FAIL: 0, SKIPPED: 0, "MANUAL VERIFICATION REQUIRED": 0 });

console.log(
  `\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIPPED} SKIPPED, `
  + `${counts["MANUAL VERIFICATION REQUIRED"]} MANUAL VERIFICATION REQUIRED`
);
if (counts.FAIL > 0) process.exitCode = 1;
