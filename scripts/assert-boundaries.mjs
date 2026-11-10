/*
 * Gate: the plugin stays a local, read-only viewer.
 *   1. no network egress  - nothing in source or build output can reach a remote host
 *   2. no raw-HTML sinks  - vault text can only reach the DOM through Obsidian's renderer
 * Exits non-zero with file:line for every violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

function scan(file, rules) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [label, re] of rules) {
      if (re.test(line)) failures.push(`${relative(root, file)}:${i + 1}  ${label}`);
    }
  });
}

const NETWORK_JS = [
  ["network call: fetch", /\bfetch\s*\(/],
  ["network call: XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["network call: WebSocket", /\bWebSocket\b/],
  ["network call: EventSource", /\bEventSource\b/],
  ["network call: sendBeacon", /\bsendBeacon\b/],
  ["network call: importScripts", /\bimportScripts\b/],
];
const SOURCE_JS = [
  ...NETWORK_JS,
  ["network call: Obsidian requestUrl/request", /\brequestUrl\b|\brequest\s*\(/],
  ["remote URL literal", /https?:\/\//],
  ["raw-HTML sink: innerHTML/outerHTML", /\.(inner|outer)HTML\b/],
  ["raw-HTML sink: insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["raw-HTML sink: document.write", /\bdocument\.write/],
  ["dynamic code: eval / new Function", /\beval\s*\(|\bnew\s+Function\b/],
];
const CSS = [
  ["remote stylesheet: @import", /@import\b/],
  ["remote asset: url() that is not a data: URI", /url\(\s*['"]?(?!data:)/],
];

for (const file of walk(join(root, "src"))) {
  if (file.endsWith(".js")) scan(file, SOURCE_JS);
  if (file.endsWith(".css")) scan(file, CSS);
}
scan(join(root, "styles.css"), CSS);
scan(join(root, "main.js"), NETWORK_JS);

if (failures.length) {
  console.error("Boundary gate FAILED:\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log("Boundary gate passed: no network egress, no raw-HTML sinks.");
