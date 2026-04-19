import esbuild from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const ctx = await esbuild.context({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/vscrt.js",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
  // Make the emitted bundle executable so `./dist/vscrt.js` works without
  // an explicit `node` prefix. npm sets the +x bit on `bin` entries, but
  // local dev (`./dist/vscrt.js diag`) needs this ourselves.
  try {
    fs.chmodSync("dist/vscrt.js", 0o755);
  } catch {
    // best-effort
  }
}
