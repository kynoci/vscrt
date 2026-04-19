/**
 * esbuild entry for the `vscrt-remote` CLI.
 *
 * Produces a single-file CommonJS bundle with a `#!/usr/bin/env node`
 * shebang. Unlike the extension bundle, `vscode` is NOT an allowed
 * external — if it sneaks in we want a build-time error, because the
 * CLI must run under plain Node without the VS Code runtime.
 *
 * Usage:
 *   node esbuild.cli.js               # dev build with sourcemaps
 *   node esbuild.cli.js --production  # minified release
 *   node esbuild.cli.js --watch       # rebuild on change
 */

const esbuild = require("esbuild");
const fs = require("fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const OUTFILE = "dist/vscrt-remote.js";

/**
 * Fail the build if `vscode` appears in the dependency graph. The
 * CLI must never require it at runtime.
 * @type {import('esbuild').Plugin}
 */
const noVscodePlugin = {
  name: "no-vscode",
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, (args) => {
      return {
        errors: [
          {
            text:
              `CLI bundle imported 'vscode' from ${args.importer}. ` +
              "The vscrt-remote bundle must stay VS Code-free — move the " +
              "vscode-using code behind the HostAdapter seam.",
          },
        ],
      };
    });
  },
};

/**
 * Prepend a shebang and chmod the output +x so the bundle is directly
 * executable on POSIX. No-op on Windows (exec bit doesn't exist).
 * @type {import('esbuild').Plugin}
 */
const shebangPlugin = {
  name: "shebang",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        return;
      }
      const outfile = build.initialOptions.outfile;
      if (!outfile || !fs.existsSync(outfile)) {
        return;
      }
      const body = fs.readFileSync(outfile, "utf8");
      if (!body.startsWith("#!")) {
        fs.writeFileSync(outfile, "#!/usr/bin/env node\n" + body, {
          encoding: "utf8",
        });
      }
      try {
        fs.chmodSync(outfile, 0o755);
      } catch {
        /* best-effort on platforms without POSIX perms */
      }
    });
  },
};

/** @type {import('esbuild').Plugin} */
const problemMatcher = {
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[cli] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [CLI ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log("[cli] build finished");
    });
  },
};

async function main() {
  // Bake the version in at build time. The source tries to read
  // `package.json` at runtime, which fails in a bundle because the
  // relative-path resolution doesn't survive bundling.
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const ctx = await esbuild.context({
    entryPoints: ["src/remote/cli/main.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    outfile: OUTFILE,
    define: {
      "process.env.VSCRT_REMOTE_VERSION": JSON.stringify(pkg.version ?? "unknown"),
    },
    // No `external` — we want a self-contained bundle. `vscode` is
    // explicitly rejected via noVscodePlugin above.
    logLevel: "silent",
    metafile: production,
    plugins: [noVscodePlugin, shebangPlugin, problemMatcher],
  });
  if (watch) {
    await ctx.watch();
  } else {
    const result = await ctx.rebuild();
    if (production && result.metafile) {
      const stat = fs.statSync(OUTFILE);
      const kb = (stat.size / 1024).toFixed(1);
      console.log(`   ${OUTFILE}: ${kb} KB (minified)`);
    }
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
