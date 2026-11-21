/*
 * Gate: a tripwire that keeps the plugin a local, read-only viewer.
 * It asks esbuild which files main.js is bundled from, and fails if one of them is first-party code outside src/
 * (files of installed packages, in this project's node_modules, are allowed), if a build option could add text of
 * its own to the bundle, or if main.js is not that bundle byte for byte. It then matches the common textual forms of
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

/* a symbolic link is listed as a file, never followed. A linked directory is therefore not scanned here: it fails
   below as an unknown file type unless its name is an editor file's, and a file bundled through it is judged by its
   real path, which is the one esbuild reports */
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
   which has no ":", no quote, no bracket, no backslash and no control character, so font data cannot match any
   of them.
   - url( must be followed by a data: URI, bare or quoted, with or without white space before it
   - the URL forms matched are an http: or https: scheme (with or without "//") anywhere, and "//" right after the
     bracket or quote that opens a value; unlike the url() rule, these also see image-set("...") and other
     functions that take a bare string
   - a backslash is refused outright: an escape can spell a function name (u\72l) or a URL (\68ttps:) that the
     other rules would not see. Neither stylesheet uses one; a character can be written as itself (UTF-8)
   - a control character is refused outright, line breaks (LF, CR LF) aside: a browser drops tabs from a URL and
     control characters from its start, so "ht<tab>tps://host" and "<U+0001>//host" are remote URLs that the rules
     above would not see. A line break cannot stand inside a CSS string, and the rules above see past one that
     stands before a URL. */
const CSS = [
  ["remote stylesheet: @import", /@import\b/gi],
  ["remote asset: url() that is not a data: URI", /url\((?!\s*['"]?data:)/gi],
  ["remote URL literal: http: or https:", /https?:/gi],
  ["remote URL literal: protocol-relative //host", /["'(]\s*\/\//g],
  ["CSS escape: backslash", /\\/g],
  ["control character other than a line break (a tab is one)", /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g],
];

/* What main.js is made of. Three checks together make the main.js on disk the bundle of source files under src/,
   which are scanned below, and files of installed packages - and of nothing else:
   - the build options (scripts/build-options.mjs) may only be the ones listed here, none of which adds text of its
     own to the bundle. A banner, a footer or a define is text that is no file, and a plugin can supply any; an
     option that is not listed fails, whatever it does;
   - esbuild's own list of the files it bundles with those options: each is either a file of an installed package
     (in this project's node_modules directory, wherever that really is on disk) or a source file under src/;
     anything else fails;
   - main.js must be, byte for byte, the bundle esbuild makes from those options here and now: text put into it by
     any other route (other options in esbuild.config.mjs, an edit by hand) fails, and so does a main.js that was
     not rebuilt after the source changed.
   Files of installed packages are not scanned as source: their text is matched only as part of main.js. */
const PLAIN_OPTIONS = ["entryPoints", "bundle", "minify", "format", "platform", "target", "external", "outfile", "logLevel"];
for (const option of Object.keys(buildOptions)) {
  if (!PLAIN_OPTIONS.includes(option)) failures.push(`scripts/build-options.mjs:1  build option "${option}": only ${PLAIN_OPTIONS.join(", ")} are accepted, because they add no text of their own to main.js`);
}
const { metafile, outputFiles } = await esbuild.build({ ...buildOptions, absWorkingDir: root, write: false, metafile: true, logLevel: "silent" });
const bundled = Object.keys(metafile.inputs);
const packages = realpathSync(join(root, "node_modules")) + sep;
const firstParty = bundled.filter((f) => !resolve(root, f).startsWith(packages));
for (const f of firstParty) {
  if (!f.startsWith("src/")) failures.push(`${f}:1  bundled first-party file outside src/: main.js may be built from src/ and installed packages only`);
}
if (outputFiles.length !== 1 || !Buffer.from(outputFiles[0].contents).equals(readFileSync(join(root, "main.js")))) {
  failures.push("main.js:1  not the bundle that the build options make from the current source: run `npm run build`, and add nothing to main.js by another route");
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
  "          no first-party file outside src/; main.js is that bundle, byte for byte",
  `          build options: ${Object.keys(buildOptions).join(", ")}  (none adds text of its own)`,
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
