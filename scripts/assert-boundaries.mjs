/*
 * Gate: a tripwire that keeps the plugin a local, read-only viewer.
 * It asks esbuild which files main.js is bundled from, and fails if one of them is first-party code outside src/
 * (files of installed packages, in this project's node_modules, are allowed). It then matches the common textual forms of
 *   1. network egress  - in every source file under src/, in both stylesheets and in the built main.js
 *   2. raw-HTML sinks  - in every source file under src/ and in the built main.js
 * and refuses any file in src/ it does not know how to scan, editor swap and backup files aside.
 * It is a pattern check, not a proof: a form that is not listed below (an aliased call, an element's
 * src attribute) passes it, and review has to catch that. The pass message says what was checked.
 * Exits non-zero with file:line for every violation.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { buildOptions } from "./build-options.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const rel = (file) => relative(root, file).split(sep).join("/");

/* a symbolic link is listed as a file, never followed: a linked directory fails below as an unknown file type */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = join(dir, d.name);
  return d.isDirectory() ? walk(p) : [p];
});

/* JavaScript is matched line by line */
function scan(file, rules) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [label, re] of rules) {
      if (re.test(line)) failures.push(`${rel(file)}:${i + 1}  ${label}`);
    }
  });
}

/* a stylesheet is matched as one text, because white space in CSS may be a line break: url(<newline>//host/x) */
function scanCss(file) {
  const text = readFileSync(file, "utf8");
  for (const [label, re] of CSS) {
    for (const m of text.matchAll(re)) failures.push(`${rel(file)}:${text.slice(0, m.index).split("\n").length}  ${label}`);
  }
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
/* The same rules for the authored src/styles.css and the generated styles.css, comments included: neither holds a
   comment that needs a URL (the generated banner points at licenses/), and the embedded typefaces are base64,
   which has no ":", no quote, no bracket and no backslash, so font data cannot match any of them.
   - the URL forms matched are an http: or https: scheme (with or without "//") anywhere, and "//" right after the
     bracket or quote that opens a value; unlike the url() rule, these also see image-set("...") and other
     functions that take a bare string
   - a backslash is refused outright: an escape can spell a function name (u\72l) or a URL (\68ttps:) that the
     other rules would not see. Neither stylesheet uses one; a character can be written as itself (UTF-8). */
const CSS = [
  ["remote stylesheet: @import", /@import\b/gi],
  ["remote asset: url() that is not a data: URI", /url\(\s*['"]?(?!data:)/gi],
  ["remote URL literal: http: or https:", /https?:/gi],
  ["remote URL literal: protocol-relative //host", /["'(]\s*\/\//g],
  ["CSS escape: backslash", /\\/g],
];

/* What main.js is made of: esbuild's own list of the files it bundles, from the options the build uses.
   A bundled file is either a file of an installed package (in this project's node_modules directory, wherever
   that really is on disk) or a source file under src/ that is scanned below; anything else fails, so first-party
   code cannot reach the bundle without being scanned as source. */
const { metafile } = await esbuild.build({ ...buildOptions, absWorkingDir: root, write: false, metafile: true, logLevel: "silent" });
const bundled = Object.keys(metafile.inputs);
const packages = realpathSync(join(root, "node_modules")) + sep;
const firstParty = bundled.filter((f) => !resolve(root, f).startsWith(packages));
for (const f of firstParty) {
  if (!f.startsWith("src/")) failures.push(`${f}:1  bundled first-party file outside src/: main.js may be built from src/ and installed packages only`);
}

/* The file types scanned as source. Any other file in src/, .css aside, fails the gate - a type esbuild could
   bundle but the gate does not scan (.mts, .json, ...) included - and so does a bundled file under src/ that
   was not scanned as source.
   Skipped: what an editor or macOS leaves next to a file being edited - .DS_Store, vim swap files (*.swp, *.swo),
   backups (*~), Emacs auto-save (#*#) and lock files (.#*) - unless esbuild lists that very file as bundled. */
const SOURCE_EXT = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"];
const EDITOR_FILE = /^(?:\.DS_Store|.*\.sw[po]|.*~|#.*#|\.#.*)$/;
const scannedSource = [], scannedCss = [], skipped = [];
for (const file of walk(join(root, "src"))) {
  const ext = extname(file), name = rel(file);
  if (EDITOR_FILE.test(basename(file)) && !bundled.includes(name)) { skipped.push(name); continue; }
  if (SOURCE_EXT.includes(ext)) { scan(file, SOURCE_JS); scannedSource.push(name); }
  else if (ext === ".css") { scanCss(file); scannedCss.push(name); }
  else failures.push(`${name}:1  unexpected file type in src/: the gate scans ${SOURCE_EXT.join(" ")} and .css only`);
}
if (!scannedSource.length) failures.push("src:1  no source file found to scan");
for (const f of firstParty) {
  if (f.startsWith("src/") && !scannedSource.includes(f)) failures.push(`${f}:1  bundled file under src/ was not scanned as source`);
}
scanCss(join(root, "styles.css"));
scan(join(root, "main.js"), BUNDLE_JS);

if (failures.length) {
  console.error("Boundary gate FAILED:\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
const labels = (rules) => rules.map(([label]) => label).join("; ");
console.log([
  "Boundary gate passed.",
  `  inputs  main.js is bundled from ${bundled.length} files (esbuild's list): ${bundled.length - firstParty.length} in node_modules, and ${firstParty.join(", ")}`,
  "          no first-party file outside src/",
  "None of these text patterns was found in",
  `  source  ${scannedSource.join(", ")}  (line by line)`,
  `          ${labels(SOURCE_JS)}`,
  `  styles  ${[...scannedCss, "styles.css"].join(", ")}  (whole text, comments included)`,
  `          ${labels(CSS)}`,
  "  bundle  main.js  (line by line)",
  `          ${labels(BUNDLE_JS)}`,
  ...(skipped.length ? [`  skipped editor files in src/, not bundled: ${skipped.join(", ")}`] : []),
  "Nothing else was checked: a form that is not listed above is not detected.",
].join("\n"));
