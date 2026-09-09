import { readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const manifestText = await readFile(resolve(projectDir, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);
const html = await readFile(resolve(projectDir, "popup.html"), "utf8");

check(manifest.manifest_version === 3, "manifest_version must be 3");
check(manifest.action?.default_popup === "popup.html", "default popup is missing");
check(!manifest.background, "background service worker is unnecessary");
check(!manifest.content_scripts, "content scripts are unnecessary");
check(!manifest.host_permissions, "host permissions are unnecessary");
check(!/\son[a-z]+\s*=/i.test(html), "HTML contains an inline event handler");
check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "HTML contains inline JavaScript");

const referencedFiles = [
  manifest.action.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action.default_icon || {}),
  ...[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])
];

for (const file of new Set(referencedFiles)) {
  try {
    await access(resolve(projectDir, file));
  } catch {
    failures.push(`Referenced file does not exist: ${file}`);
  }
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exitCode = 1;
} else {
  console.log("PASS Manifest, CSP, and referenced-file checks");
}
