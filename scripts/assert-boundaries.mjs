/*
 * Gate: a tripwire that keeps the plugin a local, read-only viewer.
 * It matches, line by line, the common textual forms of
 *   1. network egress  - in every source file under src/, in the stylesheets and in the built main.js
 *   2. raw-HTML sinks  - in every source file under src/ and in the built main.js
 * and refuses any file in src/ it does not know how to scan.
 * It is a pattern check, not a proof: a form that is not listed below (an aliased call, an element's
 * src attribute) passes it, and review has to catch that. The pass message says what was checked.
 * Exits non-zero with file:line for every violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
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
const REQUEST_JS = [
  ["network call: Obsidian requestUrl/request", /\brequestUrl\b|\brequest\s*\(/],
];
const HTML_SINK_JS = [
  ["raw-HTML sink: innerHTML/outerHTML", /\.(inner|outer)HTML\b/],
  ["raw-HTML sink: insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["raw-HTML sink: document.write", /\bdocument\.write/],
];
const SOURCE_JS = [
  ...NETWORK_JS,
  ...REQUEST_JS,
  ["remote URL literal", /https?:\/\//],
  ...HTML_SINK_JS,
  ["dynamic code: eval / new Function", /\beval\s*\(|\bnew\s+Function\b/],
];
/* the built main.js also holds three.js, whose text carries URL literals: that rule stays source-only */
const BUNDLE_JS = [...NETWORK_JS, ...REQUEST_JS, ...HTML_SINK_JS];
const CSS = [
  ["remote stylesheet: @import", /@import\b/],
  ["remote asset: url() that is not a data: URI", /url\(\s*['"]?(?!data:)/],
];

/* every extension esbuild bundles as code. Any other file in src/, .css aside, fails the gate, so a new kind
   of source file cannot be bundled without being scanned. (.DS_Store is macOS folder metadata, git-ignored.) */
const SOURCE_EXT = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"];
const scannedSource = [], scannedCss = [];
for (const file of walk(join(root, "src"))) {
  const ext = extname(file), rel = relative(root, file);
  if (basename(file) === ".DS_Store") continue;
  if (SOURCE_EXT.includes(ext)) { scan(file, SOURCE_JS); scannedSource.push(rel); }
  else if (ext === ".css") { scan(file, CSS); scannedCss.push(rel); }
  else failures.push(`${rel}:1  unexpected file type in src/: the gate scans ${SOURCE_EXT.join(" ")} and .css only`);
}
if (!scannedSource.length) failures.push("src:1  no source file found to scan");
scan(join(root, "styles.css"), CSS);
scan(join(root, "main.js"), BUNDLE_JS);

if (failures.length) {
  console.error("Boundary gate FAILED:\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
const labels = (rules) => rules.map(([label]) => label).join("; ");
console.log([
  "Boundary gate passed: none of these text patterns was found, line by line, in",
  `  source  ${scannedSource.join(", ")}`,
  `          ${labels(SOURCE_JS)}`,
  `  styles  ${[...scannedCss, "styles.css"].join(", ")}`,
  `          ${labels(CSS)}`,
  "  bundle  main.js",
  `          ${labels(BUNDLE_JS)}`,
  "Nothing else was checked: a form that is not listed above is not detected.",
].join("\n"));
