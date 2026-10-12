/**
 * build.ts — Bun-native build script for the PyPilot VSCode extension.
 *
 * Bun has a built-in bundler (`Bun.build`) so we don't need esbuild as a
 * devDependency. Run with:
 *   bun run build.ts                # one-shot build
 *   bun run build.ts --watch        # incremental watch mode
 *   bun run build.ts --production   # release build (no sourcemaps)
 */

import { watch as fsWatch } from "fs";
import { join } from "path";

const watchMode = process.argv.includes("--watch");
// .vscodeignore ships no *.map, so release builds must not emit a
// `sourceMappingURL` comment pointing at a file that is not in the VSIX.
const production = process.argv.includes("--production");

async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: ["./src/extension.ts"],
    outdir: "./out",
    target: "node",          // Bun target: generates Node-compatible CJS output.
    format: "cjs",           // VSCode extensions must be CJS.
    external: ["vscode"],    // Provided by the host at runtime — never bundle it.
    sourcemap: production ? "none" : "linked",
    minify: false,           // Keep readable; set to true for a release build.
    naming: "[dir]/[name].js",
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const msg of result.logs) {
      console.error(" ", msg);
    }
    return false;
  }

  const now = new Date().toLocaleTimeString();
  console.log(`[${now}] Built ${result.outputs.length} file(s) to ./out`);
  return true;
}

// Run the first build immediately.
const built = await build();
if (!built && !watchMode) {
  process.exit(1);
}

if (watchMode) {
  console.log("Watching src/ for changes… (Ctrl-C to stop)");

  // Bun.build doesn't have a built-in watch API yet; use fs.watch as a trigger.
  // A single save fires several events, so coalesce them and keep watching even
  // when a build fails (a syntax error must not kill the watcher).
  const srcDir = join(import.meta.dir, "src");
  let timer: ReturnType<typeof setTimeout> | undefined;
  fsWatch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      console.log(`Changed: ${filename}`);
      build().then((ok) => {
        if (!ok) console.error("Build failed — fix the error and save again.");
      });
    }, 100);
  });

  // Keep the process alive.
  await new Promise(() => {});
}
