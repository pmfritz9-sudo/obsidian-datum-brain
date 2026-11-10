import esbuild from "esbuild";
import { buildStyles } from "./scripts/build-styles.mjs";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian", "electron"],
  outfile: "main.js",
  logLevel: "info",
});

/* styles.css = embedded typefaces + src/styles.css (see scripts/build-styles.mjs) */
console.log(`  styles.css  ${(buildStyles() / 1024).toFixed(1)}kb`);
