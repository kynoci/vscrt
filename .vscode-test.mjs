import { defineConfig } from "@vscode/test-cli";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Configuration for @vscode/test-cli (integration tests running inside the
 * Extension Development Host). Requires a display or xvfb on Linux.
 *
 * Unit tests (fast, no display needed) live under `src/test/*.test.ts` and
 * are run via `npm run test:unit` (pure Mocha). Integration tests live
 * under `src/test/integration/` and require VS Code — run via
 * `npm run test:integration`.
 *
 * Isolates HOME to a fresh temp directory per run so the extension's
 * ~/.vscrt/vscrtConfig.json seeding never touches the user's real config.
 */

const tmpHome = path.join(
  os.tmpdir(),
  `vscrt-itest-${process.pid}-${Date.now()}`,
);
fs.mkdirSync(tmpHome, { recursive: true });

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  mocha: {
    ui: "bdd",
    timeout: 20000,
  },
  env: {
    HOME: tmpHome,
    USERPROFILE: tmpHome, // Windows
  },
});
