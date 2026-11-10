/*
 * The one set of esbuild options for main.js. esbuild.config.mjs writes the bundle with them; the boundary
 * gate (scripts/assert-boundaries.mjs) runs the same bundle in memory to ask esbuild which files it is made of,
 * and to compare it with the main.js on disk. The gate accepts only the option names it lists, because an option
 * can put text into the bundle that is no file (banner, footer, define, plugins): a new option goes on that list first.
 */
export const buildOptions = {
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "electron"],
  outfile: "main.js",
  logLevel: "info",
};
