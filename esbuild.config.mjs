import esbuild from "esbuild";
import { buildOptions } from "./scripts/build-options.mjs";
import { buildStyles } from "./scripts/build-styles.mjs";

await esbuild.build(buildOptions);

/* styles.css = embedded typefaces + src/styles.css (see scripts/build-styles.mjs) */
console.log(`  styles.css  ${(buildStyles() / 1024).toFixed(1)}kb`);
