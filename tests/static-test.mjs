import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(await readFile(resolve(projectDir, "manifest.json"), "utf8"));
const background = await readFile(resolve(projectDir, "background.js"), "utf8");
const offscreenHtml = await readFile(resolve(projectDir, "offscreen.html"), "utf8");
const popupHtml = await readFile(resolve(projectDir, "popup.html"), "utf8");
const expectedPermissions = ["tabs", "contextMenus", "clipboardWrite", "offscreen", "storage"];

check(manifest.manifest_version === 3, "manifest_version must be 3");
check(manifest.version === "1.2.0", "manifest version must be 1.2.0");
check(manifest.background?.service_worker === "background.js", "background service worker is missing");
check(JSON.stringify(manifest.permissions) === JSON.stringify(expectedPermissions), "permissions are not the expected minimal set");
check(manifest.action?.default_popup === "popup.html", "toolbar popup is missing");
check(!manifest.content_scripts, "content scripts must not be configured");
check(!manifest.host_permissions, "host permissions must not be configured");
check(background.includes('contexts: ["tab"]'), "tab-only context menu is missing");
check(!/https?:\/\//.test(offscreenHtml), "offscreen document contains a remote URL");
check(!/\son[a-z]+\s*=/i.test(offscreenHtml), "offscreen document contains an inline event handler");
check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(offscreenHtml), "offscreen document contains inline JavaScript");
check(!/\son[a-z]+\s*=/i.test(popupHtml), "popup contains an inline event handler");
check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(popupHtml), "popup contains inline JavaScript");

const referencedFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action.default_icon || {}),
  ...[...popupHtml.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]),
  ...[...offscreenHtml.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])
];

for (const file of new Set(referencedFiles)) {
  check(await exists(resolve(projectDir, file)), `Referenced file does not exist: ${file}`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exitCode = 1;
} else {
  console.log("PASS Manifest, dual entry points, permissions, CSP, and referenced-file checks");
}
